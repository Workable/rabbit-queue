import * as uuid from 'node-uuid';
import {getLogger} from './logger';
import * as amqp from 'amqplib';
import {Channel} from './channel';
import {addHandler} from './replyQueue';
import raceUntil from 'race-until';

export default class Queue {
  defaultOptions = {
    durable: true, noAck: false
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
      exclusive, priority, durable, autoDelete, messageTtl, expires, deadLetterExchange, deadLetterRoutingKey, maxLength
    } = this.options;
    let queueOptions: amqp.Options.AssertQueue = {
      exclusive, durable, autoDelete, messageTtl, expires, deadLetterExchange, deadLetterRoutingKey, maxLength
    };
    if (priority !== undefined) {
      queueOptions.arguments = { 'x-max-priority': priority };
    }

    await this.channel.assertQueue(this.name, queueOptions);
  }

  async subscribe(handler: (msg: any, ack: (reply) => any) => any) {
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
    if (!msg) { return; }
    const hasReply = msg.properties.replyTo;
    this.handler(msg, (reply) => {
      if (hasReply) {
        var replyBuffer = new Buffer(JSON.stringify(reply || ''));
        this.channel.sendToQueue(msg.properties.replyTo, replyBuffer, {
          correlationId: msg.properties.correlationId
        }, ack);
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
      headers = Object.assign({
        persistent: true,
        correlationId
      }, headers);
      const bufferContent = new Buffer(msg);
      getLogger().debug(`[${correlationId}] <- Publishing to queue ${name} ${bufferContent.byteLength} bytes`);
      channel.sendToQueue(name, bufferContent, headers, (err, ok) => err ? reject(err) : resolve(ok));
    });
  }

  static async getReply(obj, headers: amqp.Options.Publish, channel: Channel, name: string, queue?: Queue, timeout?: number) {
    if (queue) {
      await queue.created;
    }
    const reply = new Promise((resolve, reject) => {
      var msg = JSON.stringify(obj);
      var correlationId = headers.correlationId || uuid.v4();
      headers = Object.assign({
        persistent: false,
        correlationId,
        replyTo: channel.replyName
      }, headers);
      const bufferContent = new Buffer(msg);
      getLogger().debug(`[${correlationId}] <- Publishing to reply queue ${name} ${bufferContent.byteLength} bytes`);
      addHandler(correlationId, (err, body) => err ? reject(err) : resolve(body));
      channel.sendToQueue(name, bufferContent, headers, (err, ok) => err ? reject(err) : ({}));
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
    getLogger().debug(`created binding ${exchange} ${name} <-- ${routingKey}`);
  }

  static async unbindFromExchange(exchange, routingKey, channel: Channel, name: string, queue?: Queue) {
    if (queue) {
      await queue.created;
    }
    await channel.unbindQueue(name, exchange, routingKey);
    getLogger().debug(`deleted binding ${exchange} ${name} <-X- ${routingKey}`);
  }
}
