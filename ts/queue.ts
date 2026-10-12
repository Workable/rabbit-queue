import { randomUUID } from 'crypto';
import * as amqp from 'amqplib';
import { Channel } from './channel';
import { getReply } from './reply-queue';
import { raceUntil } from 'race-until';
import { Readable } from 'stream';
import { encode } from './encode-decode';
import getLogger from './logger';

const logger = getLogger('rabbit-queue');
const PRECONDITION_FAILED = 406;
const MAX_DECLARE_CHANNELS_PER_CONNECTION = 10;
const declareSlots = new WeakMap<amqp.ChannelModel, { inUse: number; waiting: (() => void)[] }>();

// Startup declares run concurrently; without a bound, their channels could exhaust the connection's channel_max.
async function acquireDeclareSlot(connection: amqp.ChannelModel): Promise<() => void> {
  let slots = declareSlots.get(connection);
  if (!slots) {
    slots = { inUse: 0, waiting: [] };
    declareSlots.set(connection, slots);
  }
  if (slots.inUse < MAX_DECLARE_CHANNELS_PER_CONNECTION) {
    slots.inUse++;
  } else {
    await new Promise<void>(resolve => slots.waiting.push(resolve));
  }
  return () => {
    const next = slots.waiting.shift();
    if (next) {
      next();
    } else {
      slots.inUse--;
    }
  };
}

export default class Queue {
  static STOP_PROPAGATION = { stopPropagation: true };
  static ERROR_DURING_REPLY = { error: true, error_code: 999 };
  static STOP_STREAM = 'stopStream';
  static STOP_STREAM_MESSAGE = { stopStream: true };

  defaultOptions = {
    durable: true,
    noAck: false
  };
  public options: amqp.Options.AssertQueue & amqp.Options.Consume;
  public created: Promise<any>;
  public handler: Function;
  private tag: amqp.Replies.Consume;

  constructor(public channel: Channel, public name: string, options: amqp.Options.AssertQueue & amqp.Options.Consume) {
    this.options = Object.assign({}, this.defaultOptions, options);
    this.created = this.create();
  }

  async create() {
    const {
      exclusive,
      priority,
      durable,
      autoDelete,
      messageTtl,
      expires,
      deadLetterExchange,
      deadLetterRoutingKey,
      maxLength,
    } = this.options;
    let queueOptions: amqp.Options.AssertQueue = {
      exclusive,
      durable,
      autoDelete,
      messageTtl,
      expires,
      deadLetterExchange,
      deadLetterRoutingKey,
      maxLength,
      arguments: { ...this.options.arguments }
    };
    if (priority !== undefined) {
      queueOptions.arguments = { ...queueOptions.arguments, 'x-max-priority': priority };
    }
    if (!durable || exclusive || autoDelete) {
      queueOptions.arguments ??= {};
      queueOptions.arguments['x-queue-type'] = 'classic';
    }
    if (queueOptions.arguments?.['x-max-priority'] &&
      queueOptions.arguments?.['x-queue-type'] === 'quorum') {
      logger.warn(`Invalid x-max-priority argument for quorum queue '${this.name}'`);
      delete queueOptions.arguments['x-max-priority'];
    }
    await this.assertQueue(queueOptions);
  }

  // A failed declare closes its channel, so declares run on throwaway channels and a mismatch with the
  // existing queue (e.g. classic vs quorum during a migration) can't take down the consumers.
  // Server-named queues stay on the consume channel: consume('') resolves to the last queue declared there.
  private async assertQueue(queueOptions: amqp.Options.AssertQueue) {
    if (!this.channel.channelModel || !this.name) {
      await this.channel.assertQueue(this.name, queueOptions);
      return;
    }
    try {
      await this.withDeclareChannel(channel => channel.assertQueue(this.name, queueOptions));
    } catch (error) {
      if (error.code !== PRECONDITION_FAILED) {
        throw error;
      }
      // 406 also means invalid arguments for a queue that doesn't exist yet; report that, not the 404.
      await this.withDeclareChannel(channel => channel.checkQueue(this.name)).catch(() => {
        throw error;
      });
      logger.warn(`Queue ${this.name} exists with different arguments, using it as it is: ${error.message}`);
    }
  }

  private async withDeclareChannel(declare: (channel: amqp.Channel) => Promise<unknown>) {
    const release = await acquireDeclareSlot(this.channel.channelModel);
    try {
      const channel = await this.channel.channelModel.createChannel();
      // The rejected declare already carries the error; without a listener the 'error' event would throw.
      channel.on('error', () => undefined);
      try {
        await declare(channel);
      } finally {
        await channel.close().catch(() => undefined);
      }
    } finally {
      release();
    }
  }

  async subscribe(handler: (msg: any, ack: (error?, reply?) => any) => any) {
    await this.created;
    this.handler = handler;
    this.tag = await this.channel.consume(this.name, this.onMessage.bind(this), { noAck: this.options.noAck });
  }

  async unsubscribe() {
    if (this.tag) {
      await this.channel.cancel(this.tag.consumerTag);
    }
    this.handler = null;
    this.tag = null;
  }

  static async destroy(channel: Channel, name: string) {
    await channel.deleteQueue(name);
  }

  async purge() {
    await this.channel.purgeQueue(this.name);
  }

  onMessage(msg: amqp.Message) {
    const ack = () => {
      if (!this.options.noAck) {
        this.channel.ack(msg);
      }
    };
    if (!msg) {
      return;
    }
    this.handler(msg, async (error, reply) => {
      const { replyTo, correlationId, headers } = msg.properties;
      if (error && reply !== Queue.STOP_PROPAGATION) {
        reply = Object.assign({}, Queue.ERROR_DURING_REPLY, { error_message: error });
      }

      if (!replyTo || reply === Queue.STOP_PROPAGATION) {
        ack();
      } else if (reply instanceof Readable) {
        const properties = {
          correlationId,
          contentType: 'application/json',
          headers: { isStream: true, correlationId, options: msg.properties?.headers?.options }
        };
        try {
          let id = 0;
          for await (let chunk of reply) {
            properties.correlationId = `${correlationId}.${id++}`;
            if (chunk instanceof Buffer) chunk = chunk.toString();
            if (headers.backpressure) {
              let serviceResponse = await Queue.getReply(
                chunk,
                properties,
                this.channel,
                replyTo,
                null,
                headers.timeout
              );
              if (serviceResponse && serviceResponse.stopStream === Queue.STOP_STREAM_MESSAGE.stopStream) {
                ack();
                reply.destroy();
                logger.info(`[${correlationId}] -> Received stopStream event. Closing connection`);
                return;
              }
            } else {
              const bufferContent = encode(chunk);
              logger.debug(`[${correlationId}] -> Publishing to queue ${replyTo} ${bufferContent.byteLength} bytes`);
              this.channel.sendToQueue(replyTo, bufferContent, properties);
            }
          }
          logger.debug(`[${correlationId}] -> Publishing to queue ${replyTo} 4 bytes (null)`);
          this.channel.sendToQueue(replyTo, encode(null), properties, ack);
        } catch (e) {
          logger.error(`[${correlationId}] -> Publishing to queue ${replyTo} error ${e}`);
          this.channel.sendToQueue(
            replyTo,
            encode(Object.assign({}, Queue.ERROR_DURING_REPLY, { error_message: e.message })),
            properties,
            ack
          );
        }
      } else {
        const bufferContent = encode(reply);
        logger.debug(`[${correlationId}] -> Publishing to queue ${replyTo} ${bufferContent.byteLength} bytes`);
        this.channel.sendToQueue(replyTo, bufferContent, { correlationId, contentType: 'application/json' }, ack);
      }
    });
  }

  static async publish(obj, properties: amqp.Options.Publish = {}, channel: Channel, name: string, queue?: Queue) {
    if (queue) {
      await queue.created;
    }
    return new Promise((resolve, reject) => {
      const correlationId = properties.correlationId || randomUUID();

      properties = Object.assign({ persistent: true, correlationId }, properties);
      const bufferContent = encode(obj, properties.contentType);
      logger.debug(`[${correlationId}] -> Publishing to queue ${name} ${bufferContent.byteLength} bytes`);
      channel.sendToQueue(name, bufferContent, properties, (err, ok) => (err ? reject(err) : resolve(ok)));
    });
  }

  static async getReply(
    obj,
    properties: amqp.Options.Publish,
    channel: Channel,
    name: string,
    queue?: Queue,
    timeout?: number
  ) {
    if (queue) {
      await queue.created;
    }
    const reply = getReply(obj, properties, channel, (bufferContent, properties, correlationId, cb) => {
      logger.debug(`[${correlationId}] -> Publishing to reply queue ${name} ${bufferContent.byteLength} bytes`);
      channel.sendToQueue(name, bufferContent, properties, cb);
    });
    if (timeout) {
      return raceUntil(reply, timeout, new Error('Timed out'));
    } else {
      return reply;
    }
  }

  static async bindToExchange(exchange: string, routingKey: string, channel: Channel, name: string, queue?: Queue) {
    if (queue) {
      await queue.created;
    }
    await channel.bindQueue(name, exchange, routingKey);
    logger.debug(`created binding ${exchange} routingkey:${routingKey} --> queue:${name}`);
  }

  static async unbindFromExchange(exchange, routingKey, channel: Channel, name: string, queue?: Queue) {
    if (queue) {
      await queue.created;
    }
    await channel.unbindQueue(name, exchange, routingKey);
    logger.debug(`deleted binding${exchange} routingkey:${routingKey} -X-> queue:${name}}`);
  }
}
