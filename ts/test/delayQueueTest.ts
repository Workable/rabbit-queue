import * as sinon from 'sinon';
import * as DelayQueue from '../delayQueue';
import Rabbit from '../rabbit';
import * as Queue from '../queue';
const sandbox = sinon.sandbox.create();

describe('Test DelayQueue', function() {
  let rabbit: Rabbit;

  before(function() {
    this.url = process.env.RABBIT_URL || 'amqp://localhost';
  });

  beforeEach(async function() {
    rabbit = new Rabbit(this.url);
    await rabbit.connected;
  });

  afterEach(async function() {
    sandbox.restore();
    await rabbit.destroyQueue('delay_10000');
    await rabbit.destroyQueue('delay_3000');
    await rabbit.destroyQueue('delay_10');
    await rabbit.destroyQueue('delay_reply');
  });

  it('should createDelayQueue', async function() {
    await DelayQueue.createDelayQueueReply(rabbit.channel, 'delay');
    const queueInstance = sinon.createStubInstance(Queue.default);
    const stub = sandbox.stub(Queue, 'default').returns(queueInstance);
    await DelayQueue.createDelayQueue(rabbit.channel, 'delay');
    stub.args[0].should.eql([
      rabbit.channel,
      'delay',
      {
        deadLetterExchange: '',
        deadLetterRoutingKey: 'delay_reply'
      }
    ]);
  });

  it('should createDelayQueueReply', async function() {
    const queueInstance = sinon.createStubInstance(Queue.default);
    const stub = sandbox.stub(Queue, 'default').returns(queueInstance);
    await DelayQueue.createDelayQueueReply(rabbit.channel, 'delay');
    stub.args.should.eql([[rabbit.channel, 'delay_reply', {}]]);
  });

  it('should publishWithDelay and create not existing queue', async function() {
    await DelayQueue.createDelayQueueReply(rabbit.channel, 'delay');
    const stub = sandbox.stub(Queue.default, 'publish').returns(null);
    await DelayQueue.publishWithDelay('delay', {}, {}, rabbit.channel, 'test');
    stub.calledOnce.should.be.true();
    stub.args[0].should.containDeep([{ queueName: 'test', obj: {} }, { expiration: '10000' }, 'delay_10000']);
  });

  it('should publishWithGivenDelay', async function() {
    await DelayQueue.createDelayQueueReply(rabbit.channel, 'delay');
    const stub = sandbox.stub(Queue.default, 'publish').returns(null);
    await DelayQueue.publishWithDelay('delay', {}, { expiration: '3000' }, rabbit.channel, 'test');
    stub.calledOnce.should.be.true();
    stub.args[0].should.containDeep([{ queueName: 'test', obj: {} }, { expiration: '3000' }, 'delay_3000']);
  });

  it('should call on Message', async function() {
    await DelayQueue.createDelayQueueReply(rabbit.channel, 'delay');
    const queue = new Queue.default(rabbit.channel, 'queue', { exclusive: true });
    const content = { content: true };
    let resolve;
    const promise = new Promise((r, reject) => {
      resolve = r;
    });
    await queue.subscribe(function(msg, ack) {
      ack();
      resolve(msg);
    });

    const spy = sandbox.spy(Queue.default, 'publish');
    await DelayQueue.publishWithDelay('delay', content, { expiration: '10' }, rabbit.channel, 'queue');
    spy.calledOnce.should.be.true();
    spy.args[0].should.containDeep([{ queueName: 'queue', obj: content }, { expiration: '10' }, 'delay_10']);
    (<any>await promise).content.toString().should.eql(JSON.stringify(content));
  });
});
