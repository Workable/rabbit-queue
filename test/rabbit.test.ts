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
    await rabbit.createQueue(this.name, { }, handler);
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
    await rabbit.createQueue(this.name, { arguments: { 'x-queue-type': queueType }}, handler);
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
    stub.args.should.eql([['test_delay', content, headers, rabbit.consumeChannel, `test_${this.name}`]]);
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

    async function consumeOne(options: object) {
      let onMessage: (content: string) => void;
      const received = new Promise<string>(resolve => (onMessage = resolve));
      await rabbit.createQueue(queueName, options, (msg, ack) => {
        ack();
        onMessage(msg.content.toString());
      });
      await rabbit.publish(queueName, { test: true });
      return received;
    }

    const cases = [
      { existing: 'a classic queue', declared: 'as quorum', args: {}, options: { arguments: { 'x-queue-type': 'quorum' } } },
      { existing: 'a quorum queue', declared: 'without a type', args: { 'x-queue-type': 'quorum' }, options: {} },
      { existing: 'a priority queue', declared: 'without priority', args: { 'x-max-priority': 10 }, options: {} },
      { existing: 'a queue without priority', declared: 'with priority', args: {}, options: { priority: 10 } }
    ];

    cases.forEach(({ existing, declared, args, options }) => {
      it(`should consume ${existing} declared ${declared} without disconnecting`, async function() {
        await declareExisting(args);
        rabbit = new Rabbit(this.url);
        const disconnected = sandbox.spy();
        rabbit.on('disconnected', disconnected);

        (await consumeOne(options)).should.equal(JSON.stringify({ test: true }));
        disconnected.called.should.be.false();
      });
    });

    it('should reject invalid arguments for a new queue with the original error', async function() {
      rabbit = new Rabbit(this.url);
      const disconnected = sandbox.spy();
      rabbit.on('disconnected', disconnected);

      await rabbit.createQueue(queueName, { arguments: { 'x-max-length-bytes': 'abc' } })
        .should.be.rejectedWith({ code: 406, message: /invalid arg/ });
      disconnected.called.should.be.false();
    });

    it('should reject other declare errors without disconnecting', async function() {
      rabbit = new Rabbit(this.url);
      const disconnected = sandbox.spy();
      rabbit.on('disconnected', disconnected);

      await rabbit.createQueue('amq.reserved').should.be.rejectedWith({ code: 403 });
      (await consumeOne({})).should.equal(JSON.stringify({ test: true }));
      disconnected.called.should.be.false();
    });
  });
});
