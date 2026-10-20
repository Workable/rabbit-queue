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
  public consumeConnection: amqp.ChannelModel;
  public publishConnection: amqp.ChannelModel;
  public consumeChannel: Channel;
  public publishChannel: Channel;
  public connected: Promise<any>;
  public lock: Promise<void>;
  public queues: { [s: string]: Queue } = {};
  public connecting = false;
  private attempt: Promise<void>;
  private connections = new Set<amqp.ChannelModel>();
  private lossReported = false;
  private attemptError: Error | null = null;
  private closed = false;
  public prefetch: number;
  public replyPattern: boolean;
  public prefix: string;
  public scheduledPublish: boolean;
  public socketOptions;
  private defaultQueueType: string | undefined;
  private scheduledPublishQueuesAsQuorum: boolean;
  private tolerateQueueTypeMismatch: boolean;
  public logger: ReturnType<typeof getLogger>;
  private readonly sigtermHandler: () => void;

  constructor(
    public url: string,
    {
      prefetch = 1,
      replyPattern = true,
      prefix = '',
      scheduledPublish = false,
      socketOptions = {},
      defaultQueueType = undefined,
      scheduledPublishQueuesAsQuorum = false,
      tolerateQueueTypeMismatch = false,
      cancelConsumersOnSigterm = true,
    }: {
      prefetch?: number
      replyPattern?: boolean
      prefix?: string
      scheduledPublish?: boolean
      socketOptions?: any
      defaultQueueType?: string
      scheduledPublishQueuesAsQuorum?: boolean
      tolerateQueueTypeMismatch?: boolean
      cancelConsumersOnSigterm?: boolean
    } = {}
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
    this.defaultQueueType = defaultQueueType;
    this.scheduledPublishQueuesAsQuorum = scheduledPublishQueuesAsQuorum;
    this.tolerateQueueTypeMismatch = tolerateQueueTypeMismatch;
    this.sigtermHandler = this.handleSigterm.bind(this);
    this.reconnect();

    if (cancelConsumersOnSigterm) {
      process.once('SIGTERM', this.sigtermHandler);
    }
  }

  private connect() {
    if (!this.connecting) {
      this.connecting = true;
      this.attempt = this.openConnections();
    }
    return this.attempt;
  }

  private async openConnections() {
    // Losing either connection triggers a reconnect, so the one that survived is closed here: otherwise its
    // consumers keep running next to the ones the handlers create again on "connected". Not awaited, so a
    // half-open connection still waiting for its close-ok doesn't hold up the new pair.
    this.closeAll(this.connections);
    const connections = new Set<amqp.ChannelModel>();
    this.connections = connections;
    this.lossReported = false;
    this.attemptError = null;

    try {
      const consumeConnection = await this.openConnection(connections);
      const consumeChannel = await this.createChannel(consumeConnection);
      await this.initChannel(consumeChannel);

      const publishConnection = await this.openConnection(connections);
      const publishChannel = await this.createChannel(publishConnection);
      await this.initChannel(publishChannel, true);

      if (this.attemptError) {
        throw this.attemptError;
      }
      this.consumeConnection = consumeConnection;
      this.consumeChannel = consumeChannel;
      this.publishConnection = publishConnection;
      this.publishChannel = publishChannel;
    } catch (error) {
      this.closeAll(connections);
      this.connecting = false;
      this.reportLoss(error);
      throw error;
    }
    this.connecting = false;
    this.emit('connected');
  }

  async reconnect() {
    this.closed = false;
    this.connected = this.connect();
    await this.connected.catch(() => undefined);
  }

  private async openConnection(connections: Set<amqp.ChannelModel>) {
    const connection = await amqp.connect(this.url, this.socketOptions);
    connections.add(connection);
    if (this.closed) {
      throw new Error('Rabbit was closed while connecting');
    }
    return connection;
  }

  private closeAll(connections: Iterable<amqp.ChannelModel>) {
    return Promise.all([...connections].map(connection => connection.close().catch(() => undefined)));
  }

  private connectionLost(connection: amqp.ChannelModel, error) {
    if (!this.connections.has(connection)) {
      return;
    }
    if (this.connecting) {
      this.attemptError = this.attemptError || error || new Error('Connection closed while connecting');
      return;
    }
    this.reportLoss(error);
  }

  // One outage closes a connection and its channel, and may raise errors too: report it once.
  private reportLoss(error) {
    if (this.lossReported) {
      return;
    }
    this.lossReported = true;
    this.emit('disconnected', error);
  }

  async createChannel(connection: amqp.ChannelModel) {
    connection.once('close', error => this.connectionLost(connection, error));
    connection.on('error', error => this.connectionLost(connection, error));
    const channel: Channel = await connection.createConfirmChannel();
    channel.channelModel = connection;
    return channel;
  }

  async initChannel(channel: Channel, publish = false) {
    channel.prefetch(this.prefetch);
    channel.on('close', error => this.connectionLost(channel.channelModel, error));
    if (!publish && this.replyPattern) {
      await createReplyQueue(channel);
    }
    if (!publish && this.scheduledPublish) {
      await createDelayQueueReply(channel, this.updateName('delay'), this.scheduledPublishQueuesAsQuorum);
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
    options: amqp.Options.AssertQueue & amqp.Options.Consume & { prefix?: string; prefetch?} = {},
    handler?: (msg: any, ack: (error?, reply?) => any) => any
  ) {
    if (this.defaultQueueType && !options.arguments?.['x-queue-type']) {
      options.arguments = { ...options.arguments, 'x-queue-type': this.defaultQueueType };
    }
    options.prefetch = options.prefetch || this.prefetch;
    name = this.updateName(name, options.prefix);
    await this.connected;
    const queue = new Queue(this.consumeChannel, name, {
      ...options,
      tolerateQueueTypeMismatch: this.tolerateQueueTypeMismatch
    });
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
    const queueName = this.scheduledPublishQueuesAsQuorum ? 'delay_quorum' : 'delay';
    await publishWithDelay(this.updateName(queueName), obj, properties, this.consumeChannel, name, this.scheduledPublishQueuesAsQuorum);
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
    process.off('SIGTERM', this.sigtermHandler);
    this.closed = true;
    // Covers a connect still in flight, whose connections aren't in consumeConnection/publishConnection yet.
    await this.closeAll(this.connections);
  }

  private handleSigterm() {
    this.logger.info('Received SIGTERM. Cancelling consumers..');

    for (const queue of Object.values(this.queues)) {
      queue.unsubscribe()
        .then(() => {
          this.logger.debug(`Consumer for queue ${queue.name} cancelled.`);
        }).catch(e => {
          this.logger.error(`Consumer for queue ${queue.name} failed to cancel`, e);
        });
    }
  }
}
