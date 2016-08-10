import Rabbit from '../../js/rabbit';
import 'should';
import * as assert from 'assert';
import * as sinon from 'sinon';
import Queue from '../../js/queue';
import Exchange from '../../js/exchange';
import * as ReplyQueue from '../../js/replyQueue';
const sandbox = sinon.sandbox.create();

describe('Test rabbit class', function () {
  before(function () {
    this.url = process.env.RABBIT_URL || 'amqp://localhost';
    this.name = 'test.queue';
    this.name2 = 'test.queue2';
  });

  afterEach(function () {
    sandbox.restore();
  });

  it('should throw error if called without url', function () {
    assert.throws(() => new Rabbit(null), /Url is required!/);
  });

  it('should emit "connected" on connection', function (done) {
    const rabbit = new Rabbit(this.url);
    rabbit.once('connected', done);
  });

  it('should emit "disconnected" when you close the connection', function (done) {
    const rabbit = new Rabbit(this.url, { replyPattern: false });
    rabbit.once('connected', () => {
      rabbit.once('disconnected', done);
      setTimeout(() => rabbit.close(), 100);
    });
  });

  it('should call connect only once', async function () {
    const spy = sandbox.spy(Rabbit.prototype, 'createChannel');
    const stub = sandbox.stub(ReplyQueue, 'createReplyQueue');
    const rabbit = new Rabbit(this.url);
    (<any>rabbit).connect();
    await rabbit.connected;
    spy.calledOnce.should.be.true();
    stub.called.should.be.true();
  });

  it('should not call createReplyQueue', async function () {
    const stub = sandbox.stub(ReplyQueue, 'createReplyQueue');
    const rabbit = new Rabbit(this.url, { replyPattern: false });
    await rabbit.connected;
    stub.called.should.be.false();
  });

  it('should createQueue and subscribe', async function () {
    const stub = sandbox.stub(Queue.prototype, 'subscribe');
    const rabbit = new Rabbit(this.url);
    const handler = () => ({})
    await rabbit.createQueue(this.name, { exclusive: true }, handler);
    rabbit.queues[this.name].name.should.equal(this.name);
    stub.calledWith(handler).should.be.true();
  });

  it('should createQueue and then call subscribe using prefix', async function () {
    const stub = sandbox.stub(Queue.prototype, 'subscribe');
    const rabbit = new Rabbit(this.url, { prefix: 'test' });
    await rabbit.createQueue(this.name, { exclusive: true });
    stub.called.should.be.false();
    const handler = () => ({})

    await rabbit.subscribe(this.name, handler);
    rabbit.queues['test_' + this.name].name.should.equal('test_' + this.name);
    stub.calledWith(handler).should.be.true();
  });

  it('should unsubscribe', async function () {
    const stub = sandbox.stub(Queue.prototype, 'unsubscribe');
    const rabbit = new Rabbit(this.url);
    await rabbit.createQueue(this.name2, { exclusive: true });
    await rabbit.unsubscribe(this.name2);
    stub.calledOnce.should.be.true();
  });

  it('should publish to queue', async function () {
    const stub = sandbox.stub(Queue, 'publish');
    const rabbit = new Rabbit(this.url, { prefix: 'test' });
    const content = { content: true };
    const headers = { headers: { test: 1 } };
    await rabbit.publish(`test_${this.name}`, content, headers);
    stub.calledOnce.should.be.true();
    stub.calledWith(content, headers, rabbit.channel, `test_${this.name}`, undefined).should.be.true();
  });

  it('should publish to queue with getReply', async function () {
    const stub = sandbox.stub(Queue, 'getReply');
    const rabbit = new Rabbit(this.url, { prefix: 'test' });
    await rabbit.connected;
    const content = { content: true };
    const headers = { headers: { test: 1 } };
    await rabbit.getReply(`test_${this.name}`, content, headers);
    stub.calledOnce.should.be.true();
    stub.calledWith(content, headers, rabbit.channel, `test_${this.name}`, undefined).should.be.true();
  });

  it('should publish to exchange', async function () {
    const stub = sandbox.stub(Exchange, 'publish');
    const rabbit = new Rabbit(this.url);
    const content = { content: true };
    const headers = { headers: { test: 1 } };
    await rabbit.publishExchange('amq.topic', 'testKey', content, headers);
    stub.calledOnce.should.be.true();
    stub.calledWith(rabbit.channel, 'amq.topic', 'testKey', content, headers).should.be.true();
  });

  it('should publish to topic', async function () {
    const stub = sandbox.stub(Exchange, 'publish');
    const rabbit = new Rabbit(this.url);
    const content = { content: true };
    const headers = { headers: { test: 1 } };
    await rabbit.publishTopic('testKey', content, headers);
    stub.calledOnce.should.be.true();
    stub.calledWith(rabbit.channel, 'amq.topic', 'testKey', content, headers).should.be.true();
  });

  it('should bind to exchange', async function () {
    const stub = sandbox.stub(Queue, 'bindToExchange');
    const rabbit = new Rabbit(this.url);
    await rabbit.bindToExchange(this.name, 'amq.topic', 'key');
    stub.calledWith('amq.topic', 'key', rabbit.channel, this.name, undefined).should.be.true();
  });

  it('should bind to topic', async function () {
    const stub = sandbox.stub(Queue, 'bindToExchange');
    const rabbit = new Rabbit(this.url);
    await rabbit.bindToTopic(this.name, 'key');
    stub.calledWith('amq.topic', 'key', rabbit.channel, this.name, undefined).should.be.true();
  });

  it('should unbind from exchange', async function () {
    const stub = sandbox.stub(Queue, 'unbindFromExchange');
    const rabbit = new Rabbit(this.url);
    await rabbit.unbindFromExchange(this.name, 'amq.topic', 'key');
    stub.calledWith('amq.topic', 'key', rabbit.channel, this.name, undefined).should.be.true();
  });

  it('should unbind from topic', async function () {
    const stub = sandbox.stub(Queue, 'unbindFromExchange');
    const rabbit = new Rabbit(this.url);
    await rabbit.unbindFromTopic(this.name, 'key');
    stub.calledWith('amq.topic', 'key', rabbit.channel, this.name, undefined).should.be.true();
  });

  it('should destroy queue', async function () {
    const stub = sandbox.stub(Queue, 'destroy');
    const rabbit = new Rabbit(this.url, { prefix: 'test' });
    await rabbit.destroyQueue(this.name);
    stub.calledWith(rabbit.channel, `test_${this.name}`).should.be.true();
  });
});

