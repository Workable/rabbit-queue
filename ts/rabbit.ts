import * as amqp from 'amqplib';
import { EventEmitter } from 'events';
import { createReplyQueue } from './reply-queue';
import { createDelayQueueReply, publishWithDelay } from './delay-queue';
import { Channel } from './channel';
import Queue from './queue';
import Exchange from './exchange';
import * as assert from 'assert';
import getLogger from './logger';

export default class Rabbit extends EventEmitter {
  static STOP_PROPAGATION = Queue.STOP_PROPAGATION;
  static STOP_STREAM = Queue.STOP_STREAM;
  static INSTANCE: Rabbit;
  public consumeConnection: amqp.Connection;
  public publishConnection: amqp.Connection;
  public consumeChannel: Channel;
  public publishChannel: Channel;
  public connected: Promise<any>;
  public lock: Promise<void>;
  public queues: { [s: string]: Queue } = {};
  public connecting = false;
  public prefetch: number;
  public replyPattern: boolean;
  public prefix: string;
  public scheduledPublish: boolean;
  public socketOptions;
  public logger: ReturnType<typeof getLogger>;

  constructor(
    public url: string,
    { prefetch = 1, replyPattern = true, prefix = '', scheduledPublish = false, socketOptions = {} } = {}
  ) {
    super();
    if (!Rabbit.INSTANCE) {
      Rabbit.INSTANCE = this;
    }
    this.logger = getLogger('rabbit-queue');
    assert(url, 'Url is required!');
    this.prefetch = prefetch;
    this.replyPattern = replyPattern;
    this.prefix = prefix;
    this.scheduledPublish = scheduledPublish;
    this.socketOptions = socketOptions;
    this.reconnect();
  }

  private async connect() {
    if (this.connecting) {
      return;
    }
    this.connecting = true;
    this.consumeConnection = await amqp.connect(this.url, this.socketOptions);
    this.consumeChannel = await this.createChannel(this.consumeConnection);
    await this.initChannel(this.consumeChannel);

    this.publishConnection = await amqp.connect(this.url, this.socketOptions);
    this.publishChannel = await this.createChannel(this.publishConnection);
    await this.initChannel(this.publishChannel, true);
    this.emit('connected');
    this.connecting = false;
  }

  async reconnect() {
    this.connected = this.connect();
    await this.connected.catch((error) => this.emitDisconnected(error));
  }

  private emitDisconnected(error) {
    this.connecting = false;
    this.emit('disconnected', error);
  }

  async createChannel(connection: amqp.Connection) {
    connection.once('close', (error) => this.emitDisconnected(error));
    connection.on('error', (error) => this.emitDisconnected(error));
    return connection.createConfirmChannel();
  }

  async initChannel(channel: Channel, publish = false) {
    channel.prefetch(this.prefetch);
    channel.on('close', (error) => this.emitDisconnected(error));
    if (!publish && this.replyPattern) {
      await createReplyQueue(this.consumeChannel);
    }
    if (!publish && this.scheduledPublish) {
      await createDelayQueueReply(this.consumeChannel, this.updateName('delay'));
    }
  }

  private updateName(name, prefix = this.prefix) {
    if (prefix && prefix.length > 0) {
      if (name.startsWith('.')) {
        name = `${prefix}${name}`;
      } else if (!name.startsWith(`${prefix}_`) && !name.startsWith(`${prefix}.`)) {
        name = `${prefix}_${name}`;
      }
    }
    return name;
  }

  async createQueue(
    name: string,
    options: amqp.Options.AssertQueue & { prefix?: string; prefetch? } = {},
    handler?: (msg: any, ack: (error?, reply?) => any) => any
  ) {
    options.prefetch = options.prefetch || this.prefetch;
    name = this.updateName(name, options.prefix);
    await this.connected;
    const queue = new Queue(this.consumeChannel, name, options);
    this.queues[name] = queue;
    await queue.created;
    this.logger.debug(`created queue ${name}`);
    if (handler) {
      // Handle race condition. Another queue might be created at the same time with diferrent prefetch.
      let localLock;
      do {
        localLock = this.lock;
        await this.lock;
        // More than one queues might be waiting to be created. Only one can pass this check.
      } while (this.lock !== localLock);

      if (this.prefetch !== options.prefetch) {
        this.prefetch = options.prefetch;
        this.lock = Promise.resolve(this.consumeChannel.prefetch(options.prefetch)).then(() =>
          queue.subscribe(handler)
        );
        await this.lock;
      } else {
        this.lock = queue.subscribe(handler);
        await this.lock;
      }
    }
    return queue;
  }

  async destroyQueue(name: string, prefix?: string) {
    name = this.updateName(name, prefix);
    await this.connected;
    await Queue.destroy(this.consumeChannel, name);
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
    await Queue.publish(obj, headers, this.publishChannel, name, this.queues[name]);
  }

  async publishWithDelay(name: string, obj, properties?: amqp.Options.Publish, prefix?: string) {
    if (!this.scheduledPublish) {
      throw new Error('scheduledPublish is not enabled');
    }
    name = this.updateName(name, prefix);
    await this.connected;
    await publishWithDelay(this.updateName('delay'), obj, properties, this.consumeChannel, name);
  }

  async getReply(name: string, obj, properties: amqp.Options.Publish, prefix?: string, timeout?: number) {
    name = this.updateName(name, prefix);
    await this.connected;
    return await Queue.getReply(obj, properties, this.publishChannel, name, this.queues[name], timeout);
  }

  async getTopicReply(
    topicName: string,
    content: any,
    properties: amqp.Options.Publish,
    prefix?: string,
    timeout?: number
  ) {
    topicName = this.updateName(topicName, prefix);
    await this.connected;
    return await Exchange.getReply(this.publishChannel, 'amq.topic', topicName, content, properties, timeout);
  }

  async publishExchange(exchange: string, routingKey: string, content, headers: amqp.Options.Publish, prefix?: string) {
    routingKey = this.updateName(routingKey, prefix);
    await this.connected;
    await Exchange.publish(this.publishChannel, exchange, routingKey, content, headers);
  }

  async publishTopic(topicName: string, content, headers: amqp.Options.Publish = {}, prefix?: string) {
    topicName = this.updateName(topicName, prefix);
    await this.connected;
    await Exchange.publish(this.publishChannel, 'amq.topic', topicName, content, headers);
  }

  async bindToExchange(queueName: string, exchange: string, routingKey: string, prefix?: string) {
    queueName = this.updateName(queueName, prefix);
    await this.connected;
    await Queue.bindToExchange(exchange, routingKey, this.consumeChannel, queueName, this.queues[queueName]);
  }

  async unbindFromExchange(queueName: string, exchange, topicName, prefix?: string) {
    queueName = this.updateName(queueName, prefix);
    await this.connected;
    await Queue.unbindFromExchange(exchange, topicName, this.consumeChannel, queueName, this.queues[queueName]);
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
    await this.consumeConnection.close();
    await this.publishConnection.close();
  }
}
