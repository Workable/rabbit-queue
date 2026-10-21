import { randomUUID } from 'crypto';
import * as amqp from 'amqplib';
import { Channel } from './channel';
import { getReply } from './reply-queue';
import { raceUntil } from 'race-until';
import { Readable } from 'stream';
import { encode } from './encode-decode';
import getLogger from './logger';

const logger = getLogger('rabbit-queue');
const NOT_FOUND = 404;
const PRECONDITION_FAILED = 406;
// What changes when a queue moves between classic and quorum: quorum queues have no x-max-priority.
const TOLERATED_MISMATCHES = ['x-queue-type', 'x-max-priority'];
const MAX_DECLARE_CHANNELS_PER_CONNECTION = 10;
const declareSlots = new WeakMap<amqp.ChannelModel, { inUse: number; waiting: (() => void)[] }>();

// Startup declares run concurrently; without a bound, their channels could exhaust the connection's channel_max.
async function acquireDeclareSlot(connection: amqp.ChannelModel): Promise<() => void> {
  let slots = declareSlots.get(connection);
  if (!slots) {
    slots = { inUse: 0, waiting: [] };
    declareSlots.set(connection, slots);
  }
  // amqplib's typings omit the negotiated channelMax. One channel is reserved for the consume channel;
  // at least one slot is kept so a tiny limit fails with amqplib's error instead of hanging.
  const { channelMax } = connection.connection as unknown as { channelMax: number };
  const limit = Math.max(1, Math.min(MAX_DECLARE_CHANNELS_PER_CONNECTION, channelMax - 1));
  if (slots.inUse < limit) {
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

// A failed declare closes its channel, so declares run on throwaway channels and one that fails can't take down
// the consumers. Server-named queues stay on the consume channel: consume('') resolves to the last queue declared there.
async function withDeclareChannel<T>(channel: Channel, queueName: string, declare: (channel: amqp.Channel) => Promise<T>) {
  if (!channel.channelModel || !queueName) {
    return declare(channel);
  }
  const release = await acquireDeclareSlot(channel.channelModel);
  try {
    const declareChannel = await channel.channelModel.createChannel();
    // The rejected declare already carries the error; without a listener the 'error' event would throw.
    declareChannel.on('error', () => undefined);
    try {
      return await declare(declareChannel);
    } finally {
      await declareChannel.close().catch(() => undefined);
    }
  } finally {
    release();
  }
}

export type QueueOptions = amqp.Options.AssertQueue & amqp.Options.Consume & { tolerateQueueTypeMismatch?: boolean };

export default class Queue {
  static STOP_PROPAGATION = { stopPropagation: true };
  static ERROR_DURING_REPLY = { error: true, error_code: 999 };
  static STOP_STREAM = 'stopStream';
  static STOP_STREAM_MESSAGE = { stopStream: true };

  defaultOptions = {
    durable: true,
    noAck: false
  };
  public options: QueueOptions;
  public created: Promise<any>;
  public handler: Function;
  public onCancel?: () => void;
  private tag: amqp.Replies.Consume;

  constructor(public channel: Channel, public name: string, options: QueueOptions) {
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

  private async assertQueue(queueOptions: amqp.Options.AssertQueue) {
    const tolerated: string[] = [];
    while (true) {
      try {
        await withDeclareChannel(this.channel, this.name, channel => channel.assertQueue(this.name, queueOptions));
        break;
      } catch (error) {
        const [, arg, current] = /inequivalent arg '([^']+)'.* current is (?:none|(?:the value )?'([^']*)')/.exec(error.message) ?? [];
        if (!this.options.tolerateQueueTypeMismatch || error.code !== PRECONDITION_FAILED ||
          !TOLERATED_MISMATCHES.includes(arg) || tolerated.includes(arg)) {
          throw error;
        }
        tolerated.push(arg);
        // The broker reports only the first mismatch it finds. Redeclaring with the existing value lets it check the
        // rest, so a tolerated mismatch can't hide one that isn't (e.g. x-message-ttl is checked after x-queue-type).
        const args = { ...queueOptions.arguments };
        if (current === undefined) {
          delete args[arg];
        } else {
          args[arg] = /^\d+$/.test(current) ? Number(current) : current;
        }
        queueOptions = { ...queueOptions, arguments: args };
      }
    }
    if (tolerated.length) {
      logger.warn(`Queue ${this.name} exists with a different ${tolerated.join(' and ')}, using it as it is`);
    }
  }

  get subscribed() {
    return !!this.tag;
  }

  // Resolves to whether the consumer is running: an unsubscribe or a broker cancel can land before the consume resolves.
  async subscribe(handler: (msg: any, ack: (error?, reply?) => any) => any) {
    await this.created;
    this.handler = handler;
    let tag: amqp.Replies.Consume;
    let cancelled = false;
    // amqplib calls back with null only when the broker cancels the consumer, e.g. because the queue was deleted.
    // A callback per consume tells this consumer's cancel apart from an older one's.
    const onMessage = (msg: amqp.Message) => {
      if (msg) {
        return this.onMessage(msg);
      }
      cancelled = true;
      if (tag && this.tag === tag) {
        this.tag = null;
        this.onCancel?.();
      }
    };
    tag = await this.channel.consume(this.name, onMessage, { noAck: this.options.noAck });
    if (this.handler !== handler) {
      // The unsubscribe found no tag to cancel.
      if (!cancelled) {
        await this.channel.cancel(tag.consumerTag);
      }
      return false;
    }
    if (cancelled) {
      this.onCancel?.();
      return false;
    }
    this.tag = tag;
    return true;
  }

  async unsubscribe() {
    if (this.tag) {
      await this.channel.cancel(this.tag.consumerTag);
    }
    this.handler = null;
    this.tag = null;
  }

  async exists() {
    try {
      await withDeclareChannel(this.channel, this.name, channel => channel.checkQueue(this.name));
      return true;
    } catch (error) {
      if (error.code === NOT_FOUND) {
        return false;
      }
      throw error;
    }
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
    // Deliveries can arrive between the consume-ok and an unsubscribe cancelling it; hand them back to the broker.
    if (!this.handler) {
      if (!this.options.noAck) {
        this.channel.nack(msg, false, true);
      }
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
    await withDeclareChannel(channel, name, declareChannel => declareChannel.bindQueue(name, exchange, routingKey));
    logger.debug(`created binding ${exchange} routingkey:${routingKey} --> queue:${name}`);
  }

  static async unbindFromExchange(exchange, routingKey, channel: Channel, name: string, queue?: Queue) {
    if (queue) {
      await queue.created;
    }
    await withDeclareChannel(channel, name, declareChannel => declareChannel.unbindQueue(name, exchange, routingKey));
    logger.debug(`deleted binding${exchange} routingkey:${routingKey} -X-> queue:${name}}`);
  }
}
