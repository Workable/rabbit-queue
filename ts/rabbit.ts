import * as amqp from 'amqplib';
import { EventEmitter } from 'events';
import { init, getLogger } from './logger';
import { createReplyQueue } from './replyQueue';
import { Channel } from './channel';
import Queue from './queue';
import Exchange from './exchange';
import * as assert from 'assert';

export default class Rabbit extends EventEmitter {
  static STOP_PROPAGATION = Queue.STOP_PROPAGATION;
  public connection: amqp.Connection;
  public channel: Channel;
  public connected: Promise<any>;
  public queues: { [s: string]: Queue } = {};
  public connecting = false;
  public prefetch: number;
  public replyPattern: boolean;
  public prefix: string;

  constructor(public url: string,
    {prefetch = 1, replyPattern = true, logger = null, prefix = ''} = {}) {
    super();
    assert(url, 'Url is required!');
    this.prefetch = prefetch;
    this.replyPattern = replyPattern;
    this.prefix = prefix;
    init(logger);
    this.reconnect();
  }

  private async connect() {
    if (this.connecting) { return; }
    this.connecting = true;
    let connection = await amqp.connect(this.url);
    let channel = await this.createChannel(connection);
    await this.initChannel(channel);
  }

  async reconnect() {
    this.connected = this.connect();
    this.connected.catch(error => this.emitDisconnected(error));
    await this.connected;
  }

  private emitDisconnected(error) {
    this.connecting = false;
    this.emit('disconnected', error);
  }

  async createChannel(connection: amqp.Connection) {
    this.connection = connection;
    this.connection.once('close', error => this.emitDisconnected(error));
    this.connection.on('error', error => this.emitDisconnected(error));
    return connection.createConfirmChannel();
  }

  async initChannel(channel: Channel) {
    this.channel = channel;
    this.channel.prefetch(this.prefetch);
    this.channel.on('close', error => this.emitDisconnected(error));
    if (this.replyPattern) {
      await createReplyQueue(this.channel);
    }
    this.emit('connected');
    this.connecting = false;
  }

  private updateName(name, prefix = this.prefix) {
    if (prefix && prefix.length > 0) {
      if (!name.startsWith(`${prefix}_`)) {
        name = `${prefix}_${name}`;
      }
    }
    return name;
  }

  async createQueue(
    name: string,
    options: amqp.Options.AssertQueue & { prefix?: string } = {},
    handler?: (msg: any, ack: (reply) => any) => any) {

    name = this.updateName(name, options.prefix);
    await this.connected;
    const queue = new Queue(this.channel, name, options);
    this.queues[name] = queue;
    await queue.created;
    getLogger().debug(`created queue ${name}`);
    if (handler) {
      await queue.subscribe(handler);
    }
    return queue;
  }

  async destroyQueue(name: string, prefix?: string) {
    name = this.updateName(name, prefix);
    await this.connected;
    await Queue.destroy(this.channel, name);
  }

  async subscribe(name, handler: (msg: any, ack: (reply) => any) => any, prefix?: string) {
    name = this.updateName(name, prefix);
    await this.connected;
    await this.queues[name].subscribe(handler);
  }

  async unsubscribe(name, prefix?: string) {
    name = this.updateName(name, prefix);
    await this.connected;
    await this.queues[name].unsubscribe();
  }

  async publish(name: string, obj, headers?: amqp.Options.Publish, prefix?: string) {
    name = this.updateName(name, prefix);
    await this.connected;
    await Queue.publish(obj, headers, this.channel, name, this.queues[name]);
  }

  async getReply(name: string, obj, headers: amqp.Options.Publish, prefix?: string, timeout?: number) {
    name = this.updateName(name, prefix);
    await this.connected;
    return await Queue.getReply(obj, headers, this.channel, name, this.queues[name], timeout);
  }

  async getTopicReply(topicName: string, content: any, headers: amqp.Options.Publish, prefix?: string, timeout?: number) {
    topicName = this.updateName(topicName, prefix);
    await this.connected;
    return await Exchange.getReply(this.channel, 'amq.topic', topicName, content, headers, timeout);
  }

  async publishExchange(exchange: string, routingKey: string, content, headers: amqp.Options.Publish, prefix?: string) {
    routingKey = this.updateName(routingKey, prefix);
    await this.connected;
    await Exchange.publish(this.channel, exchange, routingKey, content, headers);
  }

  async publishTopic(topicName: string, content, headers: amqp.Options.Publish = {}, prefix?: string) {
    topicName = this.updateName(topicName, prefix);
    await this.connected;
    await Exchange.publish(this.channel, 'amq.topic', topicName, content, headers);
  }

  async bindToExchange(queueName: string, exchange: string, routingKey: string, prefix?: string) {
    queueName = this.updateName(queueName, prefix);
    await this.connected;
    await Queue.bindToExchange(exchange, routingKey, this.channel, queueName, this.queues[queueName]);
  }

  async unbindFromExchange(queueName: string, exchange, topicName, prefix?: string) {
    queueName = this.updateName(queueName, prefix);
    await this.connected;
    await Queue.unbindFromExchange(exchange, topicName, this.channel, queueName, this.queues[queueName]);
  }

  async bindToTopic(queueName: string, topicName: string, prefix?: string) {
    queueName = this.updateName(queueName, prefix);
    await this.bindToExchange(queueName, 'amq.topic', topicName, prefix);
  }

  async unbindFromTopic(queueName: string, topicName: string, prefix?: string) {
    queueName = this.updateName(queueName, prefix);
    await this.unbindFromExchange(queueName, 'amq.topic', topicName, prefix);
  }

  async close() {
    await this.connection.close();
  }

}
