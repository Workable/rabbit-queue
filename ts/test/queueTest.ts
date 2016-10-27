import Rabbit from '../rabbit';
import 'should';
import * as assert from 'assert';
import * as sinon from 'sinon';
import Queue from '../queue';
const sandbox = sinon.sandbox.create();

describe('Test Queue class', function () {
  let rabbit: Rabbit;
  before(async function () {
    this.url = process.env.RABBIT_URL || 'amqp://localhost';
    this.name = 'test.queue';
    rabbit = new Rabbit(this.url);
    await rabbit.connected;
  });

  beforeEach(function () {
    this.spyAssert = sandbox.spy(rabbit.channel, 'assertQueue');
    this.spyConsume = sandbox.spy(rabbit.channel, 'consume');
    this.spyCancel = sandbox.spy(rabbit.channel, 'cancel');
    this.spyDeleteQueue = sandbox.spy(rabbit.channel, 'deleteQueue');
    this.spyPurgeQueue = sandbox.spy(rabbit.channel, 'purgeQueue');
  });

  afterEach(async function () {
    await rabbit.destroyQueue(this.name);
    sandbox.restore();
  });

  it('should create Queue', async function () {
    const queue = new Queue(rabbit.channel, this.name, { exclusive: true });
    await queue.created;
    this.spyAssert.calledOnce.should.be.true();
    this.spyAssert.calledWith(this.name,
      {
        exclusive: true,
        durable: true,
        autoDelete: undefined,
        messageTtl: undefined,
        expires: undefined,
        deadLetterExchange: undefined,
        deadLetterRoutingKey: undefined,
        maxLength: undefined
      }
    ).should.be.true();
  });

  it('should create queue and add handler to it', async function () {
    const queue = new Queue(rabbit.channel, this.name, { exclusive: true, noAck: true });
    await queue.created;
    const handler = (msg) => console.log(msg);
    await queue.subscribe(handler);
    this.spyConsume.calledOnce.should.be.true();
    this.spyConsume.args[0][0].should.equal(this.name);
    this.spyConsume.args[0][2].should.eql({
      noAck: true
    });
  });

  it('should create queue and add handler and unsubscribe', async function () {
    const queue = new Queue(rabbit.channel, this.name, { exclusive: true, noAck: true });
    await queue.created;
    const handler = (msg) => console.log(msg);
    await queue.subscribe(handler);
    await queue.unsubscribe();
    this.spyCancel.calledOnce.should.be.true();
  });

  it('should destroy queue', async function () {
    const queue = new Queue(rabbit.channel, this.name, { exclusive: true });
    await queue.created;
    await Queue.destroy(rabbit.channel, this.name);
    this.spyDeleteQueue.calledOnce.should.be.true();
    this.spyDeleteQueue.calledWith(this.name).should.be.true();
  });

  it('should purge queue', async function () {
    const queue = new Queue(rabbit.channel, this.name, { exclusive: true });
    await queue.created;
    await queue.purge();
    this.spyPurgeQueue.calledOnce.should.be.true();
    this.spyPurgeQueue.calledWith(this.name).should.be.true();
  });

  it('should publish to queue', async function () {
    const spy = sandbox.spy(rabbit.channel, 'sendToQueue');
    const content = { content: true };
    const headers = { headers: { test: 1 }, correlationId: '1', persistent: false };
    const queue = new Queue(rabbit.channel, this.name, { exclusive: true, priority: 10 });
    await Queue.publish(content, headers, rabbit.channel, this.name, queue);
    spy.calledOnce.should.be.true();
    spy.args[0].slice(0, 3).should.eql([this.name, new Buffer(JSON.stringify(content)), headers]);
  });

  it('should publish to queue with getReply', async function () {
    const spy = sandbox.spy(rabbit.channel, 'sendToQueue');
    const content = { content: true };
    const headers = { headers: { test: 1 }, correlationId: '1', persistent: false, replyTo: rabbit.channel.replyName };
    const queue = new Queue(rabbit.channel, this.name, { exclusive: true });
    await queue.subscribe((msg, ack) => ack('result'));
    const result = await Queue.getReply(content, headers, rabbit.channel, this.name, queue);
    result.should.equal('result');
    spy.calledTwice.should.be.true();
    spy.args[0].slice(0, 3).should.eql([this.name, new Buffer(JSON.stringify(content)), headers]);
  });

  it('should publish to queue with getReply but get reply after queue acknowledment', async function () {
    const spy = sandbox.spy(rabbit.channel, 'sendToQueue');
    const content = { content: true };
    const headers = { headers: { test: 1 }, correlationId: '1', persistent: false, replyTo: rabbit.channel.replyName };
    const queue = new Queue(rabbit.channel, this.name, { exclusive: true });
    await queue.subscribe((msg, ack) => ack(Queue.STOP_PROPAGATION));
    setTimeout(() => rabbit.publish(rabbit.channel.replyName, 'new_result', headers, ''), 10);
    const result = await Queue.getReply(content, headers, rabbit.channel, this.name, queue);
    result.should.equal('new_result');
    spy.calledTwice.should.be.true();
    spy.args[0].slice(0, 3).should.eql([this.name, new Buffer(JSON.stringify(content)), headers]);
  });

  it('should publish to queue with getReply and timeout', async function () {
    const spy = sandbox.spy(rabbit.channel, 'sendToQueue');
    const content = { content: true };
    const headers = { headers: { test: 1 }, correlationId: '1', persistent: false, replyTo: rabbit.channel.replyName };
    const queue = new Queue(rabbit.channel, this.name, { exclusive: true });
    await queue.subscribe((msg, ack) => setTimeout(() => ack('result'), 1));
    const result = await Queue.getReply(content, headers, rabbit.channel, this.name, queue, 10);
    result.should.equal('result');
    spy.calledTwice.should.be.true();
    spy.args[0].slice(0, 3).should.eql([this.name, new Buffer(JSON.stringify(content)), headers]);
  });

  it('should publish to queue with getReply and timeout and fail', async function () {
    const spy = sandbox.spy(rabbit.channel, 'sendToQueue');
    const content = { content: true };
    const headers = { headers: { test: 1 }, correlationId: '1', persistent: false, replyTo: rabbit.channel.replyName };
    const queue = new Queue(rabbit.channel, this.name, { exclusive: true });
    await queue.subscribe((msg, ack) => setTimeout(() => ack('result'), 10));
    try {
      await Queue.getReply(content, headers, rabbit.channel, this.name, queue, 1);
      assert(false);
    } catch (error) {
      error.should.eql(new Error('Timed out'));
    }
    spy.calledOnce.should.be.true();
    spy.args[0].slice(0, 3).should.eql([this.name, new Buffer(JSON.stringify(content)), headers]);
  });

  it('should bind to exchange', async function () {
    const spy = sandbox.spy(rabbit.channel, 'bindQueue');
    const queue = new Queue(rabbit.channel, this.name, { exclusive: true });
    await Queue.bindToExchange('amq.topic', this.name, rabbit.channel, this.name, queue);
    spy.calledWith(this.name, 'amq.topic', this.name);
  });

  it('should unbind to exchange', async function () {
    const spy = sandbox.spy(rabbit.channel, 'unbindQueue');
    const queue = new Queue(rabbit.channel, this.name, { exclusive: true });
    await Queue.unbindFromExchange('amq.topic', this.name, rabbit.channel, this.name, queue);
    spy.calledWith(this.name, 'amq.topic', this.name);
  });


});
