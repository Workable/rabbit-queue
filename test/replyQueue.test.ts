import 'should';
import * as assert from 'assert';
import * as sinon from 'sinon';
import * as ReplyQueue from '../ts/reply-queue';
import Rabbit from '../ts/rabbit';
import Queue from '../ts/queue';
import { Readable } from 'stream';
const sandbox = sinon.sandbox.create();
import * as should from 'should';

describe('Test ReplyQueue', function() {
  let rabbit: Rabbit;

  before(function() {
    this.url = process.env.RABBIT_URL || 'amqp://localhost';
  });

  afterEach(function() {
    sandbox.restore();
  });

  afterEach(async function() {
    await rabbit.close();
  });

  it('should createReplyQueue', async function() {
    rabbit = new Rabbit(this.url);
    await rabbit.connected;
    const stub = sandbox.stub(rabbit.channel, 'consume');
    await ReplyQueue.createReplyQueue(rabbit.channel);
    stub.calledOnce.should.be.true();
    stub.args[0][0].should.eql(rabbit.channel.replyName);
    stub.args[0][2].should.eql({ noAck: true });
  });

  it('should call Handler on message', async function() {
    rabbit = new Rabbit(this.url);
    await rabbit.connected;
    const stub = sandbox.stub(rabbit.channel, 'consume');
    await ReplyQueue.createReplyQueue(rabbit.channel);
    const handler = (err, body) => {
      body.should.equal('test_body');
    };
    ReplyQueue.addHandler(1, handler);
    stub.callArgWith(1, { properties: { correlationId: 1 }, content: '"test_body"' });
  });

  it('should call Handler on message and fail', async function() {
    rabbit = new Rabbit(this.url);
    await rabbit.connected;
    const stub = sandbox.stub(rabbit.channel, 'consume');
    await ReplyQueue.createReplyQueue(rabbit.channel);
    const handler = (err, body) => {
      err.should.eql(new Error());
    };
    ReplyQueue.addHandler(1, handler);
    stub.callArgWith(1, {
      properties: { correlationId: 1 },
      content: new Buffer(JSON.stringify(Queue.ERROR_DURING_REPLY))
    });
  });

  it('should call Handler on message with null message and succeed', async function() {
    rabbit = new Rabbit(this.url);
    await rabbit.connected;
    const stub = sandbox.stub(rabbit.channel, 'consume');
    await ReplyQueue.createReplyQueue(rabbit.channel);
    const handler = (err, body) => {
      assert(body === null);
    };
    ReplyQueue.addHandler(1, handler);
    stub.callArgWith(1, { properties: { correlationId: 1 }, content: 'null' });
  });

  it('should call Handler on message with isStream: true', async function() {
    rabbit = new Rabbit(this.url);
    await rabbit.connected;
    if (process.env.SKIP_STREAM) return;
    const stub = sandbox.stub(rabbit.channel, 'consume');
    await ReplyQueue.createReplyQueue(rabbit.channel);
    let handler;
    let promise = new Promise((resolve, reject) => {
      handler = async (err, body) => {
        try {
          body.should.be.instanceOf(Readable);
          const chunks = [];
          for await (const chunk of body) {
            chunks.push(chunk.toString());
          }
          chunks.should.eql(['AB', 'BC']);
        } catch (e) {
          reject(e);
        }
        resolve();
      };
    });
    ReplyQueue.addHandler(1, handler);
    stub.callArgWith(1, {
      properties: { correlationId: 1, headers: { isStream: true } },
      content: Buffer.from(JSON.stringify('AB'))
    });
    stub.callArgWith(1, {
      properties: { correlationId: 1, headers: { isStream: true } },
      content: Buffer.from(JSON.stringify('BC'))
    });
    stub.callArgWith(1, {
      properties: { correlationId: 1, headers: { isStream: true } },
      content: Buffer.from(JSON.stringify(null))
    });
    await promise;
  });

  it('should call throw error if called getReply with isStream:true with same correlationId', async function() {
    rabbit = new Rabbit(this.url);
    await rabbit.connected;
    if (process.env.SKIP_STREAM) return;
    const stub = sandbox.stub(rabbit.channel, 'consume');
    await ReplyQueue.createReplyQueue(rabbit.channel);
    let handler = () => {};
    ReplyQueue.addHandler(2, handler);
    stub.callArgWith(1, {
      properties: { correlationId: 2, headers: { isStream: true } },
      content: Buffer.from(JSON.stringify('AB'))
    });
    should.throws(() => ReplyQueue.addHandler(2, handler), /Already exists stream handler with this id: 2/);
    stub.callArgWith(1, {
      properties: { correlationId: 2, headers: { isStream: true } },
      content: Buffer.from(JSON.stringify(null))
    });
  });

  it('should emit error on message with isStream: true', async function() {
    rabbit = new Rabbit(this.url);
    await rabbit.connected;
    if (process.env.SKIP_STREAM) return;
    const stub = sandbox.stub(rabbit.channel, 'consume');
    await ReplyQueue.createReplyQueue(rabbit.channel);
    let handler;
    let promise = new Promise((resolve, reject) => {
      handler = async (err, body) => {
        try {
          body.should.be.instanceOf(Readable);
          const chunks = [];
          for await (const chunk of body) {
            chunks.push(chunk.toString());
          }
          chunks.should.eql(['AB', 'BC']);
        } catch (e) {
          e.should.eql(new Error('test-error'));
          reject(e);
        }
        resolve();
      };
    });
    ReplyQueue.addHandler(1, handler);
    stub.callArgWith(1, {
      properties: { correlationId: 1, headers: { isStream: true } },
      content: Buffer.from(JSON.stringify('AB'))
    });
    stub.callArgWith(1, {
      properties: { correlationId: 1, headers: { isStream: true } },
      content: Buffer.from(JSON.stringify('BC'))
    });
    stub.callArgWith(1, {
      properties: { correlationId: 1, headers: { isStream: true } },
      content: Buffer.from(JSON.stringify({ error: true, error_code: 999, error_message: 'test-error' }))
    });
    await promise.should.be.rejected();
  });

  it('should immediatelly emit error on message with isStream: true', async function() {
    rabbit = new Rabbit(this.url);
    await rabbit.connected;
    if (process.env.SKIP_STREAM) return;
    const stub = sandbox.stub(rabbit.channel, 'consume');
    await ReplyQueue.createReplyQueue(rabbit.channel);
    let handler;
    let promise = new Promise((resolve, reject) => {
      handler = async (err, body) => {
        try {
          body.should.be.instanceOf(Readable);
          await Promise.resolve();
          const chunks = [];
          for await (const chunk of body) {
            chunks.push(chunk.toString());
          }
          chunks.should.eql([]);
        } catch (e) {
          e.should.eql(new Error('test-error'));
          reject(e);
        }
        resolve();
      };
    });
    ReplyQueue.addHandler(1, handler);
    stub.callArgWith(1, {
      properties: { correlationId: 1, headers: { isStream: true } },
      content: Buffer.from(JSON.stringify({ error: true, error_code: 999, error_message: 'test-error' }))
    });
    await promise.should.be.rejected();
  });
});
