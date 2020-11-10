import Rabbit from '../ts/rabbit';
import 'should';
import * as assert from 'assert';
import * as sinon from 'sinon';
import Queue from '../ts/queue';
import { Readable } from 'stream';
const sandbox = sinon.createSandbox();

describe('Test Queue class', function() {
  let rabbit: Rabbit;
  before(async function() {
    this.url = process.env.RABBIT_URL || 'amqp://localhost';
    this.name = 'test.queue';
    rabbit = new Rabbit(this.url, {});
    rabbit.on('log', () => {});
    await rabbit.connected;
  });

  beforeEach(function() {
    this.spyAssert = sandbox.spy(rabbit.consumeChannel, 'assertQueue');
    this.spyConsume = sandbox.spy(rabbit.consumeChannel, 'consume');
    this.spyCancel = sandbox.spy(rabbit.consumeChannel, 'cancel');
    this.spyDeleteQueue = sandbox.spy(rabbit.consumeChannel, 'deleteQueue');
    this.spyPurgeQueue = sandbox.spy(rabbit.consumeChannel, 'purgeQueue');
  });

  afterEach(async function() {
    await rabbit.destroyQueue(this.name);
    sandbox.restore();
  });

  after(async function() {
    await rabbit.close();
  });

  it('should create Queue', async function() {
    const queue = new Queue(rabbit.consumeChannel, this.name, { exclusive: true });
    await queue.created;
    this.spyAssert.calledOnce.should.be.true();
    this.spyAssert
      .calledWith(this.name, {
        exclusive: true,
        durable: true,
        autoDelete: undefined,
        messageTtl: undefined,
        expires: undefined,
        deadLetterExchange: undefined,
        deadLetterRoutingKey: undefined,
        maxLength: undefined
      })
      .should.be.true();
  });

  it('should create queue and add handler to it', async function() {
    const queue = new Queue(rabbit.consumeChannel, this.name, { exclusive: true, noAck: true });
    await queue.created;
    const handler = msg => console.log(msg);
    await queue.subscribe(handler);
    this.spyConsume.calledOnce.should.be.true();
    this.spyConsume.args[0][0].should.equal(this.name);
    this.spyConsume.args[0][2].should.eql({
      noAck: true
    });
  });

  it('should create queue and add handler and unsubscribe', async function() {
    const queue = new Queue(rabbit.consumeChannel, this.name, { exclusive: true, noAck: true });
    await queue.created;
    const handler = msg => console.log(msg);
    await queue.subscribe(handler);
    await queue.unsubscribe();
    this.spyCancel.calledOnce.should.be.true();
  });

  it('should destroy queue', async function() {
    const queue = new Queue(rabbit.consumeChannel, this.name, { exclusive: true });
    await queue.created;
    await Queue.destroy(rabbit.consumeChannel, this.name);
    this.spyDeleteQueue.calledOnce.should.be.true();
    this.spyDeleteQueue.calledWith(this.name).should.be.true();
  });

  it('should purge queue', async function() {
    const queue = new Queue(rabbit.consumeChannel, this.name, { exclusive: true });
    await queue.created;
    await queue.purge();
    this.spyPurgeQueue.calledOnce.should.be.true();
    this.spyPurgeQueue.calledWith(this.name).should.be.true();
  });

  it('should publish to queue', async function() {
    const spy = sandbox.spy(rabbit.consumeChannel, 'sendToQueue');
    const content = { content: true };
    const headers = { headers: { test: 1 }, correlationId: '1', persistent: false };
    const queue = new Queue(rabbit.consumeChannel, this.name, { exclusive: true, priority: 10 });
    await Queue.publish(content, headers, rabbit.consumeChannel, this.name, queue);
    spy.calledOnce.should.be.true();
    spy.args[0].slice(0, 3).should.eql([this.name, Buffer.from(JSON.stringify(content)), headers]);
  });

  it('should publish to queue with getReply', async function() {
    const spy = sandbox.spy(rabbit.consumeChannel, 'sendToQueue');
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
    const result = await Queue.getReply(content, headers, rabbit.consumeChannel, this.name, queue);
    result.should.equal('result');
    spy.calledTwice.should.be.true();
    spy.args[0].slice(0, 3).should.eql([this.name, Buffer.from(JSON.stringify(content)), headers]);
  });

  it('should publish to queue with getReply but get reply after queue acknowledment', async function() {
    const spy = sandbox.spy(rabbit.publishChannel, 'sendToQueue');
    const content = { content: true };
    const headers = {
      headers: { test: 1 },
      correlationId: '1',
      persistent: false,
      replyTo: rabbit.consumeChannel.replyName,
      contentType: 'application/json'
    };
    const queue = new Queue(rabbit.consumeChannel, this.name, { exclusive: true });
    await queue.subscribe((msg, ack) => ack(null, Queue.STOP_PROPAGATION));
    setTimeout(() => rabbit.publish(rabbit.consumeChannel.replyName, 'new_result', headers, ''), 10);
    const result = await Queue.getReply(content, headers, rabbit.publishChannel, this.name, queue);
    result.should.equal('new_result');
    spy.calledTwice.should.be.true();
    spy.args[0].slice(0, 3).should.eql([this.name, Buffer.from(JSON.stringify(content)), headers]);
  });

  it('should publish to queue with getReply and timeout', async function() {
    const spy = sandbox.spy(rabbit.consumeChannel, 'sendToQueue');
    const content = { content: true };
    const headers = {
      headers: { test: 1 },
      correlationId: '1',
      persistent: false,
      replyTo: rabbit.consumeChannel.replyName,
      contentType: 'application/json'
    };
    const queue = new Queue(rabbit.consumeChannel, this.name, { exclusive: true });
    await queue.subscribe((msg, ack) => setTimeout(() => ack(null, 'result'), 1));
    const result = await Queue.getReply(content, headers, rabbit.consumeChannel, this.name, queue, 10);
    result.should.equal('result');
    spy.calledTwice.should.be.true();
    spy.args[0].slice(0, 3).should.eql([this.name, Buffer.from(JSON.stringify(content)), headers]);
  });

  it('should publish to queue with getReply and reply with error', async function() {
    const spy = sandbox.spy(rabbit.consumeChannel, 'sendToQueue');
    const content = { content: true };
    const headers = {
      headers: { test: 1 },
      correlationId: '1',
      persistent: false,
      replyTo: rabbit.consumeChannel.replyName,
      contentType: 'application/json'
    };
    const queue = new Queue(rabbit.consumeChannel, this.name, { exclusive: true });
    await queue.subscribe((msg, ack) => setTimeout(() => ack('error'), 1));
    try {
      await Queue.getReply(content, headers, rabbit.consumeChannel, this.name, queue, 10);
      assert(false);
    } catch (error) {
      error.should.eql(new Error('error'));
    }
    spy.calledTwice.should.be.true();
    spy.args[0].slice(0, 3).should.eql([this.name, new Buffer(JSON.stringify(content)), headers]);
  });

  it('should publish to queue with getReply and timeout and fail', async function() {
    const spy = sandbox.spy(rabbit.consumeChannel, 'sendToQueue');
    const content = { content: true };
    const headers = {
      headers: { test: 1 },
      correlationId: '1',
      persistent: false,
      replyTo: rabbit.consumeChannel.replyName,
      contentType: 'application/json'
    };
    const queue = new Queue(rabbit.consumeChannel, this.name, { exclusive: true });
    await queue.subscribe((msg, ack) => setTimeout(() => ack(null, 'result'), 10));
    try {
      await Queue.getReply(content, headers, rabbit.consumeChannel, this.name, queue, 1);
      assert(false);
    } catch (error) {
      error.should.eql(new Error('Timed out'));
    }
    spy.calledOnce.should.be.true();
    spy.args[0].slice(0, 3).should.eql([this.name, Buffer.from(JSON.stringify(content)), headers]);
    await new Promise(r => setTimeout(r, 10));
  });

  it('should getReply as a stream', async function() {
    if (process.env.SKIP_STREAM) return;
    const spy = sandbox.spy(rabbit.consumeChannel, 'sendToQueue');
    const content = { content: true };
    const headers = {
      headers: { test: 1, backpressure: true },
      correlationId: '1',
      persistent: false,
      replyTo: rabbit.consumeChannel.replyName,
      contentType: 'application/json'
    };
    const queue = new Queue(rabbit.consumeChannel, this.name, { exclusive: true });
    const stream = new Readable({ objectMode: true, read() {} });
    await queue.subscribe((msg, ack) => ack(null, stream));
    stream.push('AB');
    const result = await Queue.getReply(content, headers, rabbit.consumeChannel, this.name, queue);
    stream.push('BC');
    stream.push(null);
    result.constructor.should.equal(Readable);
    const chunks = [];
    for await (const chunk of result) {
      chunks.push(chunk);
    }
    chunks.should.eql(['AB', 'BC']);
    const streamHeaders = {
      correlationId: '1',
      contentType: 'application/json',
      headers: { isStream: true, correlationId: '1' },
      persistent: false,
      replyTo: queue.channel.replyName
    };
    const replyHeaders = {
      contentType: 'application/json',
      persistent: false
    };
    spy.args.should.eql([
      [this.name, Buffer.from(JSON.stringify(content)), headers, spy.args[0][3]],
      [
        rabbit.consumeChannel.replyName,
        Buffer.from(JSON.stringify('AB')),
        { ...streamHeaders, correlationId: '1.0' },
        spy.args[1][3]
      ],
      [rabbit.consumeChannel.replyName, Buffer.from(JSON.stringify(null)), { ...replyHeaders, correlationId: '1.0' }],
      [
        rabbit.consumeChannel.replyName,
        Buffer.from(JSON.stringify('BC')),
        { ...streamHeaders, correlationId: '1.1' },
        spy.args[3][3]
      ],
      [rabbit.consumeChannel.replyName, Buffer.from(JSON.stringify(null)), { ...replyHeaders, correlationId: '1.1' }],
      [
        rabbit.consumeChannel.replyName,
        Buffer.from(JSON.stringify(null)),
        { correlationId: '1.1', contentType: 'application/json', headers: { isStream: true, correlationId: '1' } },
        spy.args[5][3]
      ]
    ]);
    spy.args[0][3].should.be.Function();
    spy.args[3][3].should.be.Function();
  });

  it('should getReply as a stream and use backpressure', async function() {
    if (process.env.SKIP_STREAM) return;
    const content = { content: true };
    const spy = sandbox.spy(rabbit.consumeChannel, 'sendToQueue');
    const headers = {
      headers: { test: 1, backpressure: true },
      correlationId: '1',
      persistent: false,
      replyTo: rabbit.consumeChannel.replyName,
      contentType: 'application/json'
    };
    const queue = new Queue(rabbit.consumeChannel, this.name, { exclusive: true });
    const stream = new Readable({ objectMode: true, read() {} });
    await queue.subscribe((msg, ack) => ack(null, stream));
    stream.push({ a: 1 });
    for (let i = 2; i < 18; i++) {
      stream.push({ a: i });
    }
    stream.push(null);
    const result = await Queue.getReply(content, headers, rabbit.consumeChannel, this.name, queue);
    result.constructor.should.equal(Readable);
    await new Promise(r => setTimeout(r, 100));
    const chunks = [];
    for await (const chunk of result) {
      chunks.push(chunk);
    }
    chunks.length.should.equal(17);

    const args1_15 = [];
    for (let i = 1; i < 16; i++) {
      args1_15.push([rabbit.consumeChannel.replyName, { a: i }], [rabbit.consumeChannel.replyName, null]);
    }
    spy.args
      .map(args => [args[0], JSON.parse(args[1].toString())])
      .should.eql([
        [this.name, content],
        ...args1_15,
        [rabbit.consumeChannel.replyName, { a: 16 }],
        [rabbit.consumeChannel.replyName, { backpressure: true }],
        [rabbit.consumeChannel.replyName, { a: 17 }],
        [rabbit.consumeChannel.replyName, null],
        [rabbit.consumeChannel.replyName, null]
      ]);
  });

  it('should getReply as a stream of Objects and handle error', async function() {
    if (process.env.SKIP_STREAM) return;
    if (process.env.SKIP_NODE_EARLIER_14) return;
    const spy = sandbox.spy(rabbit.consumeChannel, 'sendToQueue');
    const content = { content: true };
    const headers = {
      headers: { test: 1 },
      correlationId: '1',
      persistent: false,
      replyTo: rabbit.consumeChannel.replyName,
      contentType: 'application/json'
    };
    const queue = new Queue(rabbit.consumeChannel, this.name, { exclusive: true });
    const stream = new Readable({ objectMode: true, read() {} });
    await queue.subscribe((msg, ack) => ack(null, stream));
    stream.push('AB');
    const result = await Queue.getReply(content, headers, rabbit.consumeChannel, this.name, queue);
    stream.push('BC');
    stream.emit('error', new Error('test-error'));
    result.constructor.should.equal(Readable);
    const chunks = [];
    try {
      for await (const chunk of result) {
        chunks.push(chunk);
      }
    } catch (e) {
      e.should.eql(new Error('test-error'));
    }
    chunks.should.eql(['AB', 'BC']);
    const streamHeaders = {
      correlationId: '1',
      contentType: 'application/json',
      headers: { isStream: true, correlationId: '1' }
    };

    spy.args.should.eql([
      [this.name, Buffer.from(JSON.stringify(content)), headers, spy.args[0][3]],
      [rabbit.consumeChannel.replyName, Buffer.from(JSON.stringify('AB')), { ...streamHeaders, correlationId: '1.1' }],
      [rabbit.consumeChannel.replyName, Buffer.from(JSON.stringify('BC')), { ...streamHeaders, correlationId: '1.1' }],
      [
        rabbit.consumeChannel.replyName,
        Buffer.from(JSON.stringify({ error: true, error_code: 999, error_message: 'test-error' })),
        { ...streamHeaders, correlationId: '1.1' },
        spy.args[3][3]
      ]
    ]);
  });

  it('should getReply as a stream of Buffers and handle error', async function() {
    if (process.env.SKIP_STREAM) return;
    if (process.env.SKIP_NODE_EARLIER_14) return;
    const spy = sandbox.spy(rabbit.consumeChannel, 'sendToQueue');
    const content = { content: true };
    const properties = {
      headers: { test: 1, backpressure: true },
      correlationId: '1',
      persistent: false,
      replyTo: rabbit.consumeChannel.replyName,
      contentType: 'application/json'
    };
    const queue = new Queue(rabbit.consumeChannel, this.name, { exclusive: true });
    const stream = new Readable({ read() {} });
    await queue.subscribe((msg, ack) => ack(null, stream));
    stream.push('AB');
    const result = await Queue.getReply(content, properties, rabbit.consumeChannel, this.name, queue);
    stream.push('BC');
    stream.emit('error', new Error('test-error'));
    result.constructor.should.equal(Readable);
    const chunks = [];
    try {
      for await (const chunk of result) {
        chunks.push(chunk);
      }
    } catch (e) {
      e.should.eql(new Error('test-error'));
    }
    chunks.should.eql(['AB', 'BC']);
    const streamHeaders = {
      correlationId: '1',
      contentType: 'application/json',
      headers: { isStream: true, correlationId: '1' },
      persistent: false,
      replyTo: queue.channel.replyName
    };
    const replyHeaders = {
      contentType: 'application/json',
      persistent: false
    };
    spy.args.should.eql([
      [this.name, Buffer.from(JSON.stringify(content)), properties, spy.args[0][3]],
      [
        rabbit.consumeChannel.replyName,
        Buffer.from(JSON.stringify('AB')),
        { ...streamHeaders, correlationId: '1.0' },
        spy.args[1][3]
      ],
      [rabbit.consumeChannel.replyName, Buffer.from(JSON.stringify(null)), { ...replyHeaders, correlationId: '1.0' }],
      [
        rabbit.consumeChannel.replyName,
        Buffer.from(JSON.stringify('BC')),
        { ...streamHeaders, correlationId: '1.1' },
        spy.args[3][3]
      ],
      [rabbit.consumeChannel.replyName, Buffer.from(JSON.stringify(null)), { ...replyHeaders, correlationId: '1.1' }],
      [
        rabbit.consumeChannel.replyName,
        Buffer.from(JSON.stringify({ error: true, error_code: 999, error_message: 'test-error' })),
        { correlationId: '1.1', contentType: 'application/json', headers: { isStream: true, correlationId: '1' } },
        spy.args[5][3]
      ]
    ]);
  });

  it('should bind to exchange', async function() {
    const spy = sandbox.spy(rabbit.consumeChannel, 'bindQueue');
    const queue = new Queue(rabbit.consumeChannel, this.name, { exclusive: true });
    await Queue.bindToExchange('amq.topic', this.name, rabbit.consumeChannel, this.name, queue);
    spy.calledWith(this.name, 'amq.topic', this.name);
  });

  it('should unbind to exchange', async function() {
    const spy = sandbox.spy(rabbit.consumeChannel, 'unbindQueue');
    const queue = new Queue(rabbit.consumeChannel, this.name, { exclusive: true });
    await Queue.unbindFromExchange('amq.topic', this.name, rabbit.consumeChannel, this.name, queue);
    spy.calledWith(this.name, 'amq.topic', this.name);
  });

  it('should getReply as a stream and stop on demand', async function() {
    if (process.env.SKIP_STREAM) return;
    const spy = sandbox.spy(rabbit.consumeChannel, 'sendToQueue');
    const content = { content: true };
    const headers = {
      headers: { test: 1, backpressure: true },
      correlationId: '1',
      persistent: false,
      replyTo: rabbit.consumeChannel.replyName,
      contentType: 'application/json'
    };
    const queue = new Queue(rabbit.consumeChannel, this.name, { exclusive: true });
    const stream = new Readable({ objectMode: true, read() {} });
    await queue.subscribe((msg, ack) => ack(null, stream));
    stream.push('AB');
    const result = await Queue.getReply(content, headers, rabbit.consumeChannel, this.name, queue);
    result.emit(Queue.STOP_STREAM);
    stream.push('BC');
    stream.push('CD');
    stream.push('DE');
    stream.push(null);
    result.constructor.should.equal(Readable);
    const chunks = [];
    for await (const chunk of result) {
      chunks.push(chunk);
    }
    chunks.should.eql(['AB']);
    const streamHeaders = {
      correlationId: '1',
      contentType: 'application/json',
      headers: { isStream: true, correlationId: '1' },
      persistent: false,
      replyTo: queue.channel.replyName
    };
    const replyHeaders = {
      contentType: 'application/json',
      persistent: false
    };
    spy.args.should.eql([
      [this.name, Buffer.from(JSON.stringify(content)), headers, spy.args[0][3]],
      [
        rabbit.consumeChannel.replyName,
        Buffer.from(JSON.stringify('AB')),
        { ...streamHeaders, correlationId: '1.0' },
        spy.args[1][3]
      ],
      [rabbit.consumeChannel.replyName, Buffer.from(JSON.stringify(null)), { ...replyHeaders, correlationId: '1.0' }],
      [
        rabbit.consumeChannel.replyName,
        Buffer.from(JSON.stringify('BC')),
        { ...streamHeaders, correlationId: '1.1' },
        spy.args[3][3]
      ],
      [
        rabbit.consumeChannel.replyName,
        Buffer.from(JSON.stringify(Queue.STOP_STREAM_MESSAGE)),
        { ...replyHeaders, correlationId: '1.1' }
      ]
    ]);
    spy.args[0][3].should.be.Function();
    spy.args[3][3].should.be.Function();
  });
});
