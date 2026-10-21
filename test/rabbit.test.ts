import Rabbit from '../ts/rabbit';
import 'should';
import * as assert from 'assert';
import * as sinon from 'sinon';
import Queue from '../ts/queue';
import Exchange from '../ts/exchange';
import * as ReplyQueue from '../ts/reply-queue';
import * as DelayQueue from '../ts/delay-queue';
import * as amqp from 'amqplib';
import { randomUUID } from 'crypto';

const { Channel: AmqpChannel } = require('amqplib/lib/channel_model');
const sandbox = sinon.createSandbox();

describe('Test rabbit class', function() {
  let rabbit: Rabbit | null;

  before(function() {
    this.url = process.env.RABBIT_URL || 'amqp://localhost';
    this.name = 'queue';
    this.name2 = 'queue2';
    this.name3 = '.queue3';
    this.name4 = 'test.queue4';
  });

  afterEach(function() {
    sandbox.restore();
  });

  afterEach(async function() {
    if (!rabbit) {
      return;
    }
    await new Promise(r => setTimeout(r, 10));
    await rabbit.close();
  });

  it('should throw error if called without url', function() {
    assert.throws(() => new Rabbit(null), /Url is required!/);
  });

  it('should emit "connected" on connection', function(done) {
    rabbit = new Rabbit(this.url);
    rabbit.once('connected', done);
  });

  it('should emit "disconnected" when you close the connection', function(done) {
    rabbit = new Rabbit(this.url, { replyPattern: false });
    rabbit.once('connected', () => {
      rabbit.once('disconnected', done);
      setTimeout(() => {
        rabbit.close();
        rabbit = null;
      }, 100);
    });
  });

  it('should not emit "connected" when closed while connecting', async function() {
    rabbit = new Rabbit(this.url, { replyPattern: false });
    const connected = sandbox.spy();
    rabbit.on('connected', connected);

    await rabbit.close();
    await rabbit.connected.should.be.rejectedWith(/closed while connecting/);

    connected.called.should.be.false();
    rabbit = null;
  });

  it('should call amqp connect with socketOptions', async function() {
    const connectStub = sandbox.spy(amqp, 'connect');
    rabbit = new Rabbit(this.url, { socketOptions: 'socketOptions' });
    (<any>rabbit).connect();
    await rabbit.connected;
    connectStub.args.should.eql([
      [this.url, 'socketOptions'],
      [this.url, 'socketOptions']
    ]);
  });

  it('should call connect only once', async function() {
    const createChannelSpy = sandbox.spy(Rabbit.prototype, 'createChannel');
    const createReplyQueueStub = sandbox.stub(ReplyQueue, 'createReplyQueue');
    rabbit = new Rabbit(this.url);
    (<any>rabbit).connect();
    await rabbit.connected;
    createChannelSpy.args.should.eql([[rabbit.consumeConnection], [rabbit.publishConnection]]);
    createReplyQueueStub.called.should.be.true();
  });

  it('should not call createReplyQueue', async function() {
    const stub = sandbox.stub(ReplyQueue, 'createReplyQueue');
    rabbit = new Rabbit(this.url, { replyPattern: false });
    await rabbit.connected;
    stub.called.should.be.false();
  });

  it('should createQueue and subscribe', async function() {
    const stub = sandbox.stub(Queue.prototype, 'subscribe');
    rabbit = new Rabbit(this.url);
    const handler = () => ({});
    await rabbit.createQueue(this.name, { exclusive: true }, handler);
    rabbit.queues[this.name].name.should.equal(this.name);
    stub.calledWith(handler).should.be.true();
  });

  it('should createQueue and then call subscribe using prefix', async function() {
    const stub = sandbox.stub(Queue.prototype, 'subscribe');
    rabbit = new Rabbit(this.url, { prefix: 'test' });
    await rabbit.createQueue(this.name, { exclusive: true });
    stub.called.should.be.false();
    const handler = () => ({});

    await rabbit.subscribe(this.name, handler);
    rabbit.queues['test_' + this.name].name.should.equal('test_' + this.name);
    stub.calledWith(handler).should.be.true();
  });

  it('should createQueue and change prefetch', async function() {
    const stub = sandbox.stub(Queue.prototype, 'subscribe');
    rabbit = new Rabbit(this.url);
    await rabbit.connected;
    const spy = sandbox.spy(rabbit.consumeChannel, 'prefetch');
    const prefetchAtSubscribe = {};
    stub.callsFake(async function() {
      prefetchAtSubscribe[this.name] = spy.lastCall.args[0];
    });
    const handler = () => ({});
    let promises = [];
    promises.push(rabbit.createQueue(this.name, { exclusive: true, prefetch: 20 }, handler));
    promises.push(rabbit.createQueue(this.name2, { exclusive: true, prefetch: 15 }, handler));
    promises.push(rabbit.createQueue(this.name3, { exclusive: true, prefetch: 10 }, handler));
    promises.push(rabbit.createQueue(this.name4, { exclusive: true, prefetch: 10 }, handler));
    await Promise.all(promises);
    prefetchAtSubscribe.should.eql({ [this.name]: 20, [this.name2]: 15, [this.name3]: 10, [this.name4]: 10 });
    rabbit.queues[this.name].name.should.equal(this.name);
    stub.calledWith(handler).should.be.true();
  });

  it('should create queue with max priority when priority is specified', async function() {
    const subscription = sandbox.stub(Queue.prototype, 'subscribe');
    rabbit = new Rabbit(this.url);
    await rabbit.connected;
    const stub = sandbox.stub(AmqpChannel.prototype, 'assertQueue')
      .resolves({ queue: this.name, messageCount: 0, consumerCount: 0 });
    const priority = 23;
    const handler = () => {};
    await rabbit.createQueue(this.name, { priority: priority }, handler);
    subscription.calledWith(handler).should.be.true();
    const [name, options] = stub.firstCall.args;
    name.should.equal(this.name);
    options!.arguments['x-max-priority'].should.equals(priority);
  });

  it('should apply queue type when defaultQueueType is provided', async function() {
    const subscription = sandbox.stub(Queue.prototype, 'subscribe');
    const queueType = 'classic';
    rabbit = new Rabbit(this.url, { defaultQueueType: queueType });
    await rabbit.connected;
    const stub = sandbox.stub(AmqpChannel.prototype, 'assertQueue')
      .resolves({ queue: this.name, messageCount: 0, consumerCount: 0 });
    const handler = () => {};
    await rabbit.createQueue(this.name, {}, handler);
    subscription.calledWith(handler).should.be.true();
    const [name, options] = stub.firstCall.args;
    name.should.equal(this.name);
    options!.arguments['x-queue-type'].should.equals(queueType);
  });

  it('should not set x-queue-type when neither default nor explicit queue type is provided', async function() {
    const subscription = sandbox.stub(Queue.prototype, 'subscribe');
    rabbit = new Rabbit(this.url);
    await rabbit.connected;
    const stub = sandbox.stub(AmqpChannel.prototype, 'assertQueue')
      .resolves({ queue: this.name, messageCount: 0, consumerCount: 0 });
    const handler = () => {};
    await rabbit.createQueue(this.name, {}, handler);
    subscription.calledWith(handler).should.be.true();
    stub.calledOnce.should.be.true();
    const [name, options] = stub.firstCall.args;
    name.should.equal(this.name);
    options!.arguments.should.not.have.property('x-queue-type');
  });

  it('should use the provided queue type instead of the default', async function() {
    const subscription = sandbox.stub(Queue.prototype, 'subscribe');
    rabbit = new Rabbit(this.url, { defaultQueueType: 'classic' });
    await rabbit.connected;
    const stub = sandbox.stub(AmqpChannel.prototype, 'assertQueue')
      .resolves({ queue: this.name, messageCount: 0, consumerCount: 0 });
    const handler = () => {};
    const queueType = 'quorum';
    await rabbit.createQueue(this.name, { arguments: { 'x-queue-type': queueType } }, handler);
    subscription.calledWith(handler).should.be.true();
    const [name, options] = stub.firstCall.args;
    name.should.equal(this.name);
    options!.arguments['x-queue-type'].should.equals(queueType);
  });

  it('should ignore priority when creating a quorum queue', async function() {
    const subscription = sandbox.stub(Queue.prototype, 'subscribe');
    rabbit = new Rabbit(this.url, { defaultQueueType: 'quorum' });
    await rabbit.connected;
    const stub = sandbox.stub(AmqpChannel.prototype, 'assertQueue')
      .resolves({ queue: this.name, messageCount: 0, consumerCount: 0 });
    const handler = () => {};
    await rabbit.createQueue(this.name, { priority: 23 }, handler);
    subscription.calledWith(handler).should.be.true();
    stub.calledOnce.should.be.true();
    const [name, options] = stub.firstCall.args;
    name.should.equal(this.name);
    options!.arguments.should.not.have.property('x-max-priority');
  });

  it('should set queue type to classic when creating a non durable queue', async function() {
    const subscription = sandbox.stub(Queue.prototype, 'subscribe');
    rabbit = new Rabbit(this.url, { defaultQueueType: 'quorum' });
    await rabbit.connected;
    const stub = sandbox.stub(AmqpChannel.prototype, 'assertQueue')
      .resolves({ queue: this.name, messageCount: 0, consumerCount: 0 });
    const handler = () => {};
    await rabbit.createQueue(this.name, { durable: false }, handler);
    subscription.calledWith(handler).should.be.true();
    stub.calledOnce.should.be.true();
    const [name, options] = stub.firstCall.args;
    name.should.equal(this.name);
    options!.arguments['x-queue-type'].should.equals('classic');
  });

  it('should set queue type to classic when creating an exclusive queue', async function() {
    const subscription = sandbox.stub(Queue.prototype, 'subscribe');
    rabbit = new Rabbit(this.url, { defaultQueueType: 'quorum' });
    await rabbit.connected;
    const stub = sandbox.stub(AmqpChannel.prototype, 'assertQueue')
      .resolves({ queue: this.name, messageCount: 0, consumerCount: 0 });
    const handler = () => {};
    await rabbit.createQueue(this.name, { exclusive: true }, handler);
    subscription.calledWith(handler).should.be.true();
    stub.calledOnce.should.be.true();
    const [name, options] = stub.firstCall.args;
    name.should.equal(this.name);
    options!.arguments['x-queue-type'].should.equals('classic');
  });

  it('should set queue type to classic when creating an auto delete queue', async function() {
    const subscription = sandbox.stub(Queue.prototype, 'subscribe');
    rabbit = new Rabbit(this.url, { defaultQueueType: 'quorum' });
    await rabbit.connected;
    const stub = sandbox.stub(AmqpChannel.prototype, 'assertQueue')
      .resolves({ queue: this.name, messageCount: 0, consumerCount: 0 });
    const handler = () => {};
    await rabbit.createQueue(this.name, { autoDelete: true }, handler);
    subscription.calledWith(handler).should.be.true();
    stub.calledOnce.should.be.true();
    const [name, options] = stub.firstCall.args;
    name.should.equal(this.name);
    options!.arguments['x-queue-type'].should.equals('classic');
  });

  it('should unsubscribe', async function() {
    const stub = sandbox.stub(Queue.prototype, 'unsubscribe');
    rabbit = new Rabbit(this.url);
    await rabbit.createQueue(this.name2, { exclusive: true });
    await rabbit.unsubscribe(this.name2);
    stub.calledOnce.should.be.true();
  });

  it('should publish to queue by adding prefix_', async function() {
    const publishStub = sandbox.stub(Queue, 'publish');
    rabbit = new Rabbit(this.url, { prefix: 'test' });
    const content = { content: true };
    const headers = { headers: { test: 1 } };
    await rabbit.publish(`test_${this.name}`, content, headers);
    publishStub.args.should.eql([[content, headers, rabbit.publishChannel, `test_${this.name}`, undefined]]);
  });

  it('should publish to queue by adding only prefix when name starts with .', async function() {
    const stub = sandbox.stub(Queue, 'publish');
    rabbit = new Rabbit(this.url, { prefix: 'test' });
    const content = { content: true };
    const headers = { headers: { test: 1 } };
    await rabbit.publish(this.name3, content, headers);
    stub.calledOnce.should.be.true();
    stub.calledWith(content, headers, rabbit.publishChannel, `test${this.name3}`, undefined).should.be.true();
  });

  it('should publish to queue by adding only prefix when name starts with prefix.', async function() {
    const stub = sandbox.stub(Queue, 'publish');
    rabbit = new Rabbit(this.url, { prefix: 'test' });
    const content = { content: true };
    const headers = { headers: { test: 1 } };
    await rabbit.publish(this.name4, content, headers);
    stub.calledOnce.should.be.true();
    stub.calledWith(content, headers, rabbit.publishChannel, `${this.name4}`, undefined).should.be.true();
  });

  it('should publish to queue with Delay', async function() {
    const stub = sandbox.stub(DelayQueue, 'publishWithDelay');
    rabbit = new Rabbit(this.url, { prefix: 'test', scheduledPublish: true });
    const content = { content: true };
    const headers = { headers: { test: 1 } };
    await rabbit.publishWithDelay(`test_${this.name}`, content, headers);
    stub.calledOnce.should.be.true();
    stub.args.should.eql([['test_delay', content, headers, rabbit.consumeChannel, `test_${this.name}`, false]]);
  });

  it('should publish to queue with getReply', async function() {
    const stub = sandbox.stub(Queue, 'getReply').returns(Promise.resolve('reply'));
    rabbit = new Rabbit(this.url, { prefix: 'test' });
    await rabbit.connected;
    const content = { content: true };
    const headers = { headers: { test: 1 } };
    const reply = await rabbit.getReply(`test_${this.name}`, content, headers);
    reply.should.equal('reply');
    stub.calledOnce.should.be.true();
    stub.calledWith(content, headers, rabbit.publishChannel, `test_${this.name}`, undefined).should.be.true();
  });

  it('should publish to topic with getReply', async function() {
    const stub = sandbox.stub(Exchange, 'getReply').returns(Promise.resolve('reply'));
    rabbit = new Rabbit(this.url, { prefix: 'test' });
    await rabbit.connected;
    const content = { content: true };
    const headers = { headers: { test: 1 } };
    const reply = await rabbit.getTopicReply(`test_${this.name}`, content, headers);
    reply.should.equal('reply');
    stub.calledOnce.should.be.true();
    stub.calledWith(rabbit.publishChannel, 'amq.topic', `test_${this.name}`, content, headers, undefined).should.be.true();
  });

  it('should publish to exchange', async function() {
    const stub = sandbox.stub(Exchange, 'publish');
    rabbit = new Rabbit(this.url);
    const content = { content: true };
    const headers = { headers: { test: 1 } };
    await rabbit.publishExchange('amq.topic', 'testKey', content, headers);
    stub.calledOnce.should.be.true();
    stub.calledWith(rabbit.publishChannel, 'amq.topic', 'testKey', content, headers).should.be.true();
  });

  it('should publish to topic', async function() {
    const stub = sandbox.stub(Exchange, 'publish');
    rabbit = new Rabbit(this.url);
    const content = { content: true };
    const headers = { headers: { test: 1 } };
    await rabbit.publishTopic('testKey', content, headers);
    stub.calledOnce.should.be.true();
    stub.calledWith(rabbit.publishChannel, 'amq.topic', 'testKey', content, headers).should.be.true();
  });

  it('should bind to exchange', async function() {
    const stub = sandbox.stub(Queue, 'bindToExchange');
    rabbit = new Rabbit(this.url);
    await rabbit.bindToExchange(this.name, 'amq.topic', 'key');
    stub.calledWith('amq.topic', 'key', rabbit.consumeChannel, this.name, undefined).should.be.true();
  });

  it('should bind to topic', async function() {
    const stub = sandbox.stub(Queue, 'bindToExchange');
    rabbit = new Rabbit(this.url);
    await rabbit.bindToTopic(this.name, 'key');
    stub.calledWith('amq.topic', 'key', rabbit.consumeChannel, this.name, undefined).should.be.true();
  });

  it('should unbind from exchange', async function() {
    const stub = sandbox.stub(Queue, 'unbindFromExchange');
    rabbit = new Rabbit(this.url);
    await rabbit.unbindFromExchange(this.name, 'amq.topic', 'key');
    stub.calledWith('amq.topic', 'key', rabbit.consumeChannel, this.name, undefined).should.be.true();
  });

  it('should unbind from topic', async function() {
    const stub = sandbox.stub(Queue, 'unbindFromExchange');
    rabbit = new Rabbit(this.url);
    await rabbit.unbindFromTopic(this.name, 'key');
    stub.calledWith('amq.topic', 'key', rabbit.consumeChannel, this.name, undefined).should.be.true();
  });

  it('should destroy queue', async function() {
    const stub = sandbox.stub(Queue, 'destroy');
    rabbit = new Rabbit(this.url, { prefix: 'test' });
    await rabbit.destroyQueue(this.name);
    stub.calledWith(rabbit.consumeChannel, `test_${this.name}`).should.be.true();
  });

  it('should register sigtermHandler in SIGTERM process listeners and remove on close', async function() {
    rabbit = new Rabbit(this.url);
    await rabbit.connected;

    const handler = (rabbit as any).sigtermHandler;

    process.listeners('SIGTERM').should.containEql(handler);

    rabbit.close();
    rabbit = null;

    process.listeners('SIGTERM').should.not.containEql(handler);
  });

  it('should keep consumers on SIGTERM when cancelConsumersOnSigterm is false', async function() {
    const stub = sandbox.stub(Queue.prototype, 'unsubscribe').resolves();
    const listenersBefore = process.listeners('SIGTERM');

    rabbit = new Rabbit(this.url, { cancelConsumersOnSigterm: false });
    await rabbit.connected;
    await rabbit.createQueue(randomUUID().toString(), { exclusive: true }, () => ({}));

    const added = process.listeners('SIGTERM').filter(l => !listenersBefore.includes(l));
    added.should.be.empty();
    added.forEach(l => (l as () => void)());
    stub.called.should.be.false();
  });

  it('should call unsubscribe for all queues on SIGTERM', async function() {
    const stub = sandbox.stub(Queue.prototype, 'unsubscribe').resolves();

    rabbit = new Rabbit(this.url);
    await rabbit.connected;

    const handler = () => ({});
    await rabbit.createQueue(randomUUID().toString(), { exclusive: true }, handler);
    await rabbit.createQueue(randomUUID().toString(), { exclusive: true }, handler);

    (rabbit as any).sigtermHandler();
    stub.calledTwice.should.be.true();
  });

  describe('when scheduledPublishQueuesAsQuorum option is true', function() {
    it('should publish to queue with Delay, and use quorum delay queue', async function() {
      const stub = sandbox.stub(DelayQueue, 'publishWithDelay');
      rabbit = new Rabbit(this.url, { prefix: 'test', scheduledPublish: true, scheduledPublishQueuesAsQuorum: true });
      const content = { content: true };
      const headers = { headers: { test: 1 } };
      await rabbit.publishWithDelay(`test_${this.name}`, content, headers);
      stub.calledOnce.should.be.true();
      stub.args.should.eql([['test_delay_quorum', content, headers, rabbit.consumeChannel, `test_${this.name}`, true]]);
    });
  });

  describe('when the queue exists with different arguments', function() {
    let admin: amqp.ChannelModel;
    let queueName: string;

    beforeEach(async function() {
      admin = await amqp.connect(this.url);
      queueName = `existing_${randomUUID()}`;
    });

    afterEach(async function() {
      const channel = await admin.createChannel();
      await channel.deleteQueue(queueName);
      await admin.close();
    });

    async function declareExisting(args: object) {
      const channel = await admin.createChannel();
      await channel.assertQueue(queueName, { durable: true, arguments: args });
      await channel.close();
    }

    async function consumeOne(options: object, name = queueName) {
      let onMessage: (content: string) => void;
      const received = new Promise<string>(resolve => (onMessage = resolve));
      await rabbit.createQueue(name, options, (msg, ack) => {
        ack();
        onMessage(msg.content.toString());
      });
      await rabbit.publish(name, { test: true });
      return received;
    }

    async function consumeTemporaryQueue() {
      return consumeOne({ exclusive: true }, `temporary_${randomUUID()}`);
    }

    const cases = [
      { existing: 'a classic queue', declared: 'as quorum', args: {}, options: { arguments: { 'x-queue-type': 'quorum' } } },
      { existing: 'a quorum queue', declared: 'without a type', args: { 'x-queue-type': 'quorum' }, options: {} },
      { existing: 'a priority queue', declared: 'without priority', args: { 'x-max-priority': 10 }, options: {} },
      { existing: 'a queue without priority', declared: 'with priority', args: {}, options: { priority: 10 } },
      {
        existing: 'a classic priority queue',
        declared: 'as quorum',
        args: { 'x-max-priority': 10 },
        options: { arguments: { 'x-queue-type': 'quorum' } }
      }
    ];

    cases.forEach(({ existing, declared, args, options }) => {
      it(`should consume ${existing} declared ${declared} when tolerating type mismatches`, async function() {
        await declareExisting(args);
        rabbit = new Rabbit(this.url, { tolerateQueueTypeMismatch: true });
        const disconnected = sandbox.spy();
        rabbit.on('disconnected', disconnected);

        (await consumeOne(options)).should.equal(JSON.stringify({ test: true }));
        disconnected.called.should.be.false();
      });
    });

    it('should reject a type mismatch by default without disconnecting', async function() {
      await declareExisting({ 'x-queue-type': 'quorum' });
      rabbit = new Rabbit(this.url);
      const disconnected = sandbox.spy();
      rabbit.on('disconnected', disconnected);

      await rabbit.createQueue(queueName, {}).should.be.rejectedWith({ code: 406, message: /inequivalent arg 'x-queue-type'/ });
      (await consumeTemporaryQueue()).should.equal(JSON.stringify({ test: true }));
      disconnected.called.should.be.false();
    });

    const otherMismatches = [
      {
        existing: 'a queue with another dead-letter routing key',
        args: { 'x-dead-letter-exchange': '', 'x-dead-letter-routing-key': 'old' },
        options: { deadLetterExchange: '', deadLetterRoutingKey: 'new' },
        mismatch: 'x-dead-letter-routing-key'
      },
      {
        existing: 'a quorum queue with another dead-letter routing key',
        args: { 'x-queue-type': 'quorum', 'x-dead-letter-exchange': '', 'x-dead-letter-routing-key': 'old' },
        options: { deadLetterExchange: '', deadLetterRoutingKey: 'new' },
        mismatch: 'x-dead-letter-routing-key'
      },
      {
        existing: 'a quorum queue with another TTL',
        args: { 'x-queue-type': 'quorum', 'x-message-ttl': 60000 },
        options: { messageTtl: 30000 },
        mismatch: 'x-message-ttl'
      },
      {
        existing: 'a classic priority queue with another overflow',
        args: { 'x-max-priority': 10, 'x-overflow': 'drop-head' },
        options: { arguments: { 'x-queue-type': 'quorum', 'x-overflow': 'reject-publish' } },
        mismatch: 'x-overflow'
      }
    ];

    otherMismatches.forEach(({ existing, args, options, mismatch }) => {
      it(`should reject ${existing} when tolerating type mismatches`, async function() {
        await declareExisting(args);
        rabbit = new Rabbit(this.url, { tolerateQueueTypeMismatch: true });
        const disconnected = sandbox.spy();
        rabbit.on('disconnected', disconnected);

        await rabbit.createQueue(queueName, options)
          .should.be.rejectedWith({ code: 406, message: new RegExp(`inequivalent arg '${mismatch}'`) });
        (await consumeTemporaryQueue()).should.equal(JSON.stringify({ test: true }));
        disconnected.called.should.be.false();
      });
    });

    it('should reject invalid arguments for a new queue', async function() {
      rabbit = new Rabbit(this.url, { tolerateQueueTypeMismatch: true });
      const disconnected = sandbox.spy();
      rabbit.on('disconnected', disconnected);

      await rabbit.createQueue(queueName, { arguments: { 'x-max-length-bytes': 'abc' } })
        .should.be.rejectedWith({ code: 406, message: /invalid arg/ });
      disconnected.called.should.be.false();
    });

    it('should reject other declare errors without disconnecting', async function() {
      rabbit = new Rabbit(this.url, { tolerateQueueTypeMismatch: true });
      const disconnected = sandbox.spy();
      rabbit.on('disconnected', disconnected);

      await rabbit.createQueue('amq.reserved').should.be.rejectedWith({ code: 403 });
      (await consumeOne({})).should.equal(JSON.stringify({ test: true }));
      disconnected.called.should.be.false();
    });
  });

  describe('when one of the two connections drops', function() {
    let admin: amqp.ChannelModel;
    let queueName: string;

    beforeEach(async function() {
      admin = await amqp.connect(this.url);
      queueName = `reconnect_${randomUUID()}`;
      const channel = await admin.createChannel();
      await channel.assertQueue(queueName, { durable: true });
      await channel.close();
    });

    afterEach(async function() {
      rabbit?.removeAllListeners('connected');
      rabbit?.removeAllListeners('disconnected');
      const channel = await admin.createChannel();
      await channel.deleteQueue(queueName);
      await admin.close();
    });

    async function consumerCount() {
      const channel = await admin.createChannel();
      const { consumerCount: count } = await channel.checkQueue(queueName);
      await channel.close();
      return count;
    }

    async function waitForConsumers(expected: number, attempts = 50) {
      for (let attempt = 0; attempt < attempts && (await consumerCount()) !== expected; attempt++) {
        await new Promise(r => setTimeout(r, 20));
      }
      (await consumerCount()).should.equal(expected);
    }

    // What orka does: reconnect on every "disconnected" and create the handlers' queues again on "connected".
    function resubscribeOnReconnect() {
      rabbit.on('disconnected', () => setTimeout(() => rabbit.reconnect(), 10));
      rabbit.on('connected', () => rabbit.createQueue(queueName, {}, () => ({})));
    }

    it('should keep one consumer per queue after the publish connection drops', async function() {
      rabbit = new Rabbit(this.url, { replyPattern: false });
      resubscribeOnReconnect();
      await rabbit.connected;
      await waitForConsumers(1);

      const reconnected = new Promise(resolve => rabbit.once('connected', resolve));
      await rabbit.publishConnection.close();
      await reconnected;
      await new Promise(r => setTimeout(r, 200));

      (await consumerCount()).should.equal(1);
    });

    it('should close the surviving publish connection after the consume connection drops', async function() {
      rabbit = new Rabbit(this.url, { replyPattern: false });
      resubscribeOnReconnect();
      await rabbit.connected;
      await waitForConsumers(1);
      const survivorClose = sandbox.spy(rabbit.publishConnection, 'close');

      const reconnected = new Promise(resolve => rabbit.once('connected', resolve));
      await rabbit.consumeConnection.close();
      await reconnected;
      await new Promise(r => setTimeout(r, 200));

      survivorClose.called.should.be.true();
      (await consumerCount()).should.equal(1);
    });

    describe('when the broker cancels a consumer because its queue was deleted', function() {
      this.timeout(10000);

      async function replaceQueue(args: object, afterMs: number) {
        const channel = await admin.createChannel();
        await channel.deleteQueue(queueName);
        await new Promise(r => setTimeout(r, afterMs));
        await channel.assertQueue(queueName, { durable: true, arguments: args });
        await channel.close();
      }

      async function queueExists() {
        const channel = await admin.createChannel();
        channel.on('error', () => undefined);
        try {
          await channel.checkQueue(queueName);
          await channel.close();
          return true;
        } catch (error) {
          return false;
        }
      }

      it('should consume again once the queue is declared again', async function() {
        rabbit = new Rabbit(this.url, { replyPattern: false });
        const disconnected = sandbox.spy();
        rabbit.on('disconnected', disconnected);
        let onMessage: (content: string) => void;
        const received = new Promise<string>(resolve => (onMessage = resolve));
        await rabbit.createQueue(queueName, {}, (msg, ack) => {
          ack();
          onMessage(msg.content.toString());
        });

        await replaceQueue({ 'x-queue-type': 'quorum' }, 300);
        await waitForConsumers(0);
        await waitForConsumers(1, 250);
        await rabbit.publish(queueName, { test: true });

        (await received).should.equal(JSON.stringify({ test: true }));
        (await consumerCount()).should.equal(1);
        disconnected.called.should.be.false();
      });

      it('should wait for the queue instead of declaring it', async function() {
        rabbit = new Rabbit(this.url, { replyPattern: false });
        await rabbit.createQueue(queueName, {}, () => ({}));

        const channel = await admin.createChannel();
        await channel.deleteQueue(queueName);
        await channel.close();
        await new Promise(r => setTimeout(r, 1500));
        (await queueExists()).should.be.false();

        await replaceQueue({}, 0);
        await waitForConsumers(1, 250);
      });

      it('should subscribe again with the queue\'s own prefetch', async function() {
        rabbit = new Rabbit(this.url, { replyPattern: false });
        await rabbit.createQueue(queueName, { prefetch: 5 }, () => ({}));
        await rabbit.createQueue(`other_${randomUUID()}`, { exclusive: true, prefetch: 1 }, () => ({}));
        const prefetch = sandbox.spy(rabbit.consumeChannel, 'prefetch');

        await replaceQueue({}, 0);
        await waitForConsumers(1, 250);

        (await consumerCount()).should.equal(1);
        prefetch.calledWith(5).should.be.true();
      });

      it('should not subscribe again after unsubscribing', async function() {
        rabbit = new Rabbit(this.url, { replyPattern: false });
        await rabbit.createQueue(queueName, {}, () => ({}));

        const channel = await admin.createChannel();
        await channel.deleteQueue(queueName);
        await channel.close();
        await rabbit.unsubscribe(queueName);
        await replaceQueue({}, 0);
        await new Promise(r => setTimeout(r, 1500));

        (await consumerCount()).should.equal(0);
      });

      it('should not subscribe again when unsubscribed while subscribing again', async function() {
        rabbit = new Rabbit(this.url, { replyPattern: false });
        const queue = await rabbit.createQueue(queueName, {}, () => ({}));
        const exists = queue.exists.bind(queue);
        sandbox.stub(queue, 'exists').callsFake(async () => {
          const found = await exists();
          await rabbit.unsubscribe(queueName);
          return found;
        });

        await replaceQueue({}, 0);
        await new Promise(r => setTimeout(r, 1500));

        (queue.exists as sinon.SinonStub).called.should.be.true();
        (await consumerCount()).should.equal(0);
      });
    });

    it('should emit "disconnected" once when a connection and its channel close', async function() {
      rabbit = new Rabbit(this.url, { replyPattern: false });
      await rabbit.connected;
      const disconnected = sandbox.spy();
      rabbit.on('disconnected', disconnected);

      await rabbit.publishConnection.close();
      await new Promise(r => setTimeout(r, 100));

      disconnected.callCount.should.equal(1);
      await rabbit.consumeConnection.close();
      rabbit = null;
    });
  });
});
