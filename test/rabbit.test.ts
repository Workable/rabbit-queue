import Rabbit from '../ts/rabbit';
import 'should';
import * as assert from 'assert';
import * as sinon from 'sinon';
import Queue from '../ts/queue';
import Exchange from '../ts/exchange';
import * as ReplyQueue from '../ts/reply-queue';
import * as DelayQueue from '../ts/delay-queue';
import * as amqp from 'amqplib';

const sandbox = sinon.createSandbox();

describe('Test rabbit class', function() {
  let rabbit: Rabbit;

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
    const handler = () => ({});
    let promises = [];
    promises.push(rabbit.createQueue(this.name, { exclusive: true, prefetch: 20 }, handler));
    promises.push(rabbit.createQueue(this.name2, { exclusive: true, prefetch: 15 }, handler));
    promises.push(rabbit.createQueue(this.name3, { exclusive: true, prefetch: 10 }, handler));
    promises.push(rabbit.createQueue(this.name4, { exclusive: true, prefetch: 10 }, handler));
    await Promise.all(promises);
    spy.args.should.eql([[20], [15], [10]]);
    rabbit.queues[this.name].name.should.equal(this.name);
    stub.calledWith(handler).should.be.true();
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
});
