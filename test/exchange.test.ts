import 'should';
import * as assert from 'assert';
import * as sinon from 'sinon';
import Exchange from '../ts/exchange';
import Rabbit from '../ts/rabbit';
import Queue from '../ts/queue';
const sandbox = sinon.createSandbox();

describe('Test Exchange', function() {
  let rabbit: Rabbit;

  before(async function() {
    this.name = 'test.queue';
    this.url = process.env.RABBIT_URL || 'amqp://localhost';
    rabbit = new Rabbit(this.url, {});
    rabbit.on('log', () => {});
    await rabbit.connected;
  });

  afterEach(async function() {
    await rabbit.destroyQueue(this.name);
    sandbox.restore();
  });

  after(async function() {
    await rabbit.close();
  });

  it('should publish to exchange', async function() {
    const stub = sandbox.stub(rabbit.consumeChannel, 'publish');
    stub.callsArgWith(4, null, 'ok');
    const content = { content: true };
    const headers = {
      headers: { test: 1 },
      correlationId: '1',
      persistent: false,
      contentType: 'application/json'
    };
    await Exchange.publish(rabbit.consumeChannel, 'exchange', 'routingKey', content, headers);
    stub.calledOnce.should.be.true();
    stub.args[0].slice(0, 4).should.eql(['exchange', 'routingKey', new Buffer(JSON.stringify(content)), headers]);
  });

  it('should publish to topic with getReply', async function() {
    const spy = sandbox.spy(rabbit.consumeChannel, 'publish');
    const content = { content: true };
    const headers = {
      headers: { test: 1 },
      correlationId: '1',
      persistent: false,
      replyTo: rabbit.consumeChannel.replyName,
      contentType: 'application/json'
    };
    const queue = new Queue(rabbit.consumeChannel, this.name, { exclusive: true });
    await queue.subscribe((msg, ack) => ack(null, 'result'));
    await rabbit.bindToTopic(this.name, 'binding');
    const result = await Exchange.getReply(rabbit.consumeChannel, 'amq.topic', 'binding', content, headers);
    result.should.equal('result');
    spy.calledTwice.should.be.true();
    spy.args[0].slice(0, 4).should.eql(['amq.topic', 'binding', new Buffer(JSON.stringify(content)), headers]);
  });

  it('should publish to topic with getReply and timeout and fail', async function() {
    const spy = sandbox.spy(rabbit.consumeChannel, 'publish');
    const content = { content: true };
    const headers = {
      headers: { test: 1 },
      correlationId: '2',
      persistent: false,
      replyTo: rabbit.consumeChannel.replyName,
      contentType: 'application/json'
    };
    const queue = new Queue(rabbit.consumeChannel, this.name, { exclusive: true });
    await queue.subscribe((msg, ack) => setTimeout(() => ack(null, 'result'), 10));
    await rabbit.bindToTopic(this.name, 'binding');
    try {
      await Exchange.getReply(rabbit.consumeChannel, 'amq.topic', 'binding', content, headers, 1);
      assert(false);
    } catch (error) {
      error.should.eql(new Error('Timed out'));
    }
    spy.calledOnce.should.be.true();
    await new Promise(resolve => setTimeout(resolve, 10));
    spy.args[0].slice(0, 4).should.eql(['amq.topic', 'binding', new Buffer(JSON.stringify(content)), headers]);
  });

  it('should publish to topic with getReply and fail', async function() {
    const spy = sandbox.spy(rabbit.consumeChannel, 'publish');
    const content = { content: true };
    const headers = {
      headers: { test: 1 },
      correlationId: '3',
      persistent: false,
      replyTo: rabbit.consumeChannel.replyName,
      contentType: 'application/json'
    };
    const queue = new Queue(rabbit.consumeChannel, this.name, { exclusive: true });
    await queue.subscribe((msg, ack) => setTimeout(() => ack('error'), 10));
    await rabbit.bindToTopic(this.name, 'binding');
    try {
      await Exchange.getReply(rabbit.consumeChannel, 'amq.topic', 'binding', content, headers);
      assert(false);
    } catch (error) {
      error.should.eql(new Error('error'));
    }
    spy.calledTwice.should.be.true();
    spy.args[0].slice(0, 4).should.eql(['amq.topic', 'binding', new Buffer(JSON.stringify(content)), headers]);
  });
});
