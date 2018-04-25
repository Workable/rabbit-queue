import 'should';
import * as assert from 'assert';
import * as sinon from 'sinon';
import Exchange from '../exchange';
import Rabbit from '../rabbit';
import Queue from '../queue';
const sandbox = sinon.sandbox.create();

describe('Test Exchange', function() {
  let rabbit: Rabbit;

  before(async function() {
    this.name = 'test.queue';
    this.url = process.env.RABBIT_URL || 'amqp://localhost';
    rabbit = new Rabbit(this.url, {});
    await rabbit.connected;
  });

  afterEach(async function() {
    await rabbit.destroyQueue(this.name);
    sandbox.restore();
  });

  it('should publish to exchange', async function() {
    const stub = sandbox.stub(rabbit.channel, 'publish');
    stub.callsArgWith(4, null, 'ok');
    const content = { content: true };
    const headers = { headers: { test: 1 }, persistent: false };
    await Exchange.publish(rabbit.channel, 'exchange', 'routingKey', content, headers);
    stub.calledOnce.should.be.true();
    stub.args[0].slice(0, 4).should.eql(['exchange', 'routingKey', new Buffer(JSON.stringify(content)), headers]);
  });

  it('should publish to topic with getReply', async function() {
    const spy = sandbox.spy(rabbit.channel, 'publish');
    const content = { content: true };
    const headers = { headers: { test: 1 }, correlationId: '1', persistent: false, replyTo: rabbit.channel.replyName };
    const queue = new Queue(rabbit.channel, this.name, { exclusive: true });
    await queue.subscribe((msg, ack) => ack(null, 'result'));
    await rabbit.bindToTopic(this.name, 'binding');
    const result = await Exchange.getReply(rabbit.channel, 'amq.topic', 'binding', content, headers);
    result.should.equal('result');
    spy.calledTwice.should.be.true();
    spy.args[0].slice(0, 4).should.eql(['amq.topic', 'binding', new Buffer(JSON.stringify(content)), headers]);
  });

  it('should publish to topic with getReply and timeout and fail', async function() {
    const spy = sandbox.spy(rabbit.channel, 'publish');
    const content = { content: true };
    const headers = { headers: { test: 1 }, correlationId: '2', persistent: false, replyTo: rabbit.channel.replyName };
    const queue = new Queue(rabbit.channel, this.name, { exclusive: true });
    await queue.subscribe((msg, ack) => setTimeout(() => ack(null, 'result'), 10));
    await rabbit.bindToTopic(this.name, 'binding');
    try {
      await Exchange.getReply(rabbit.channel, 'amq.topic', 'binding', content, headers, 1);
      assert(false);
    } catch (error) {
      error.should.eql(new Error('Timed out'));
    }
    spy.calledOnce.should.be.true();
    await new Promise(resolve => setTimeout(resolve, 10));
    spy.args[0].slice(0, 4).should.eql(['amq.topic', 'binding', new Buffer(JSON.stringify(content)), headers]);
  });

  it('should publish to topic with getReply and fail', async function() {
    const spy = sandbox.spy(rabbit.channel, 'publish');
    const content = { content: true };
    const headers = { headers: { test: 1 }, correlationId: '3', persistent: false, replyTo: rabbit.channel.replyName };
    const queue = new Queue(rabbit.channel, this.name, { exclusive: true });
    await queue.subscribe((msg, ack) => setTimeout(() => ack('error'), 10));
    await rabbit.bindToTopic(this.name, 'binding');
    try {
      await Exchange.getReply(rabbit.channel, 'amq.topic', 'binding', content, headers);
      assert(false);
    } catch (error) {
      error.should.eql(new Error('error'));
    }
    spy.calledTwice.should.be.true();
    spy.args[0].slice(0, 4).should.eql(['amq.topic', 'binding', new Buffer(JSON.stringify(content)), headers]);
  });
});
