import * as uuid from 'uuid';
import * as amqp from 'amqplib';
import { Channel } from './channel';
import { getReply } from './reply-queue';
import { raceUntil } from 'race-until';
import { Readable } from 'stream';
import { encode } from './encode-decode';
import getLogger from './logger';

const logger = getLogger('rabbit-queue');
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
      maxLength
    } = this.options;
    let queueOptions: amqp.Options.AssertQueue = {
      exclusive,
      durable,
      autoDelete,
      messageTtl,
      expires,
      deadLetterExchange,
      deadLetterRoutingKey,
      maxLength
    };
    if (priority !== undefined) {
      queueOptions.arguments = { 'x-max-priority': priority };
    }

    await this.channel.assertQueue(this.name, queueOptions);
  }

  async subscribe(handler: (msg: any, ack: (error?, reply?) => any) => any) {
    await this.created;
    this.handler = handler;
    let tag = await this.channel.consume(this.name, this.onMessage.bind(this), { noAck: this.options.noAck });
    this.tag = tag;
  }

  async unsubscribe() {
    await this.channel.cancel(this.tag.consumerTag);
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
          headers: { isStream: true, correlationId }
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
      const correlationId = properties.correlationId || uuid.v4();

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
