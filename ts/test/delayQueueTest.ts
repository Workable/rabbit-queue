import * as sinon from 'sinon';
import * as DelayQueue from '../delayQueue';
import Rabbit from '../rabbit';
import * as Queue from '../queue';
const sandbox = sinon.sandbox.create();

describe('Test DelayQueue', function () {
  let rabbit: Rabbit;

  before(function () {
    this.url = process.env.RABBIT_URL || 'amqp://localhost';
  });

  beforeEach(async function () {
    rabbit = new Rabbit(this.url);
    await rabbit.connected;
  });

  afterEach(async function () {
    sandbox.restore();
    await rabbit.destroyQueue('test');
    await rabbit.destroyQueue('test_reply');
  });

  it('should createDelayQueue', async function () {
    const queueInstance = sinon.createStubInstance(Queue.default);
    const stub = sandbox.stub(Queue, 'default').returns(queueInstance);
    await DelayQueue.createDelayQueue(rabbit.channel, 'test');
    stub.calledTwice.should.be.true();
    stub.args[0].should.eql([rabbit.channel, 'test', {
      deadLetterExchange: '',
      deadLetterRoutingKey: 'test_reply'
    }]);
    stub.args[1].should.eql([rabbit.channel, 'test_reply', {}]);
    (<any>queueInstance).subscribe.calledOnce.should.be.true();
  });

  it('should publishWithDelay', async function () {
    const stub = sandbox.stub(Queue.default, 'publish').returns(null);
    await DelayQueue.createDelayQueue(rabbit.channel, 'test');
    await DelayQueue.publishWithDelay({}, {}, rabbit.channel, 'test');
    stub.calledOnce.should.be.true();
    stub.args[0].should.containDeep([{ queueName: 'test', obj: {} }, { expiration: '10000' }, 'test']);
  });

  it('should publishWithGivenDelay', async function () {
    const stub = sandbox.stub(Queue.default, 'publish').returns(null);
    await DelayQueue.createDelayQueue(rabbit.channel, 'test');
    await DelayQueue.publishWithDelay({}, { expiration: '3000' }, rabbit.channel, 'test');
    stub.calledOnce.should.be.true();
    stub.args[0].should.containDeep([{ queueName: 'test', obj: {} }, { expiration: '3000' }, 'test']);
  });

  it('should call on Message', async function () {
    const queue = new Queue.default(rabbit.channel, 'queue', { exclusive: true });
    const content = { content: true };
    let resolve;
    const promise = new Promise((r, reject) => { resolve = r; });
    await queue.subscribe(function (msg, ack) {
      ack(null);
      resolve(msg);
    });

    const spy = sandbox.spy(Queue.default, 'publish');
    await DelayQueue.createDelayQueue(rabbit.channel, 'test');
    await DelayQueue.publishWithDelay(content, { expiration: '10' }, rabbit.channel, 'queue');
    spy.calledOnce.should.be.true();
    spy.args[0].should.containDeep([{ queueName: 'queue', obj: content }, { expiration: '10' }, 'test']);
    (<any>await promise).content.toString().should.eql(JSON.stringify(content));
  });
});
