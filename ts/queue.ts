import * as uuid from 'uuid';
import * as amqp from 'amqplib';
import { Channel } from './channel';
import { getReply } from './replyQueue';
import raceUntil from 'race-until';
import * as log4js from '@log4js-node/log4js-api';

const logger = log4js.getLogger('rabbit-queue');

export default class Queue {
  static STOP_PROPAGATION = { stopPropagation: true };
  static ERROR_DURING_REPLY = { error: true, error_code: 999 };

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
    const hasReply = !!msg.properties.replyTo;
    this.handler(msg, (error, reply) => {
      if (hasReply && reply !== Queue.STOP_PROPAGATION) {
        if (error) {
          reply = Object.assign({}, Queue.ERROR_DURING_REPLY, { error_message: error });
        }
        var replyBuffer = Buffer.from(JSON.stringify(reply || ''));
        this.channel.sendToQueue(
          msg.properties.replyTo,
          replyBuffer,
          {
            correlationId: msg.properties.correlationId
          },
          ack
        );
      } else {
        ack();
      }
    });
  }

  static async publish(obj, headers: amqp.Options.Publish = {}, channel: Channel, name: string, queue?: Queue) {
    if (queue) {
      await queue.created;
    }
    return new Promise((resolve, reject) => {
      var msg = JSON.stringify(obj);
      var correlationId = headers.correlationId || uuid.v4();
      headers = Object.assign(
        {
          persistent: true,
          correlationId
        },
        headers
      );
      const bufferContent = Buffer.from(msg);
      logger.info(`[${correlationId}] -> Publishing to queue ${name} ${bufferContent.byteLength} bytes`);
      channel.sendToQueue(name, bufferContent, headers, (err, ok) => (err ? reject(err) : resolve(ok)));
    });
  }

  static async getReply(
    obj,
    headers: amqp.Options.Publish,
    channel: Channel,
    name: string,
    queue?: Queue,
    timeout?: number
  ) {
    if (queue) {
      await queue.created;
    }
    const reply = getReply(obj, headers, channel, (bufferContent, headers, correlationId, cb) => {
      logger.info(`[${correlationId}] -> Publishing to reply queue ${name} ${bufferContent.byteLength} bytes`);
      channel.sendToQueue(name, bufferContent, headers, cb);
    });
    if (timeout) {
      return raceUntil(reply, timeout, false);
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
