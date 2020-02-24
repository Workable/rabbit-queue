import * as should from 'should';
import * as assert from 'assert';
import * as sinon from 'sinon';
import Rabbit from '../ts/rabbit';
import BaseQueueHandler from '../ts/base-queue-handler';
const sandbox = sinon.createSandbox();

describe('Test baseQueueHandler', function() {
  let rabbit: Rabbit;

  class DemoHandler extends BaseQueueHandler {
    handle({ msg, event, correlationId, startTime }) {
      console.log('Received: ', event);
      console.log('With correlation id: ' + correlationId);
    }

    afterDlq({ msg, event }) {
      // Something to do after added to dlq
    }
  }

  before(async function() {
    this.url = process.env.RABBIT_URL || 'amqp://localhost';
    this.name = 'test.queue';
    rabbit = new Rabbit(this.url, {});
    await rabbit.connected;
    rabbit.on('log', () => {});
  });

  after(async function() {
    await rabbit.close();
  });

  afterEach(async function() {
    await rabbit.destroyQueue(this.name);
    await rabbit.destroyQueue(this.name + '_dlq');
    sandbox.restore();
  });

  it('should handle message', async function() {
    const handler = new DemoHandler(this.name, rabbit, {});
    const handle = (handler.handle = sandbox.stub());
    await rabbit.publish(this.name, { test: 'data' }, { correlationId: '3' });
    await new Promise(resolve => setTimeout(resolve, 10));
    handle.calledOnce.should.be.true();
    handle.args[0][0].event.should.eql({ test: 'data' });
    handle.args[0][0].correlationId.should.equal('3');
  });

  it('should pass options to createQueue', async function() {
    const stub = sandbox.spy(rabbit, 'createQueue');
    const handler = new DemoHandler(this.name, rabbit, { prefetch: 10 });
    await handler.created;
    stub.args.should.containDeep([['test.queue', { prefetch: 10 }]]);
  });

  it('should mess context', async function() {
    const handler = new DemoHandler(this.name, rabbit, {});
    const handle = (handler.handle = function({ event }) {
      this.context = event.test;
    });
    await rabbit.publish(this.name, { test: 'data' }, { correlationId: '3' });
    await new Promise(resolve => setTimeout(resolve, 10));
    (<any>handler).context.should.equal('data');
    await rabbit.publish(this.name, { test: 'data2' }, { correlationId: '4' });
    (<any>handler).context.should.equal('data2');
  });

  it('should not mess context', async function() {
    const handle = DemoHandler.prototype.handle;
    DemoHandler.prototype.handle = function({ event }) {
      this.context = event;
    };
    const handler = DemoHandler.prototypeFactory(this.name, rabbit, { logger: (<any>global).logger });
    await rabbit.publish(this.name, { test: 'data' }, { correlationId: '3' });
    should.equal(undefined, (<any>handler).context);
    await rabbit.publish(this.name, { test: 'data2' }, { correlationId: '3' });
    should.equal(undefined, this.context);
    DemoHandler.prototype.handle = handle;
  });

  it('should add to dlq after x retries', async function() {
    sandbox.useFakeTimers();
    const handler = new DemoHandler(this.name, rabbit, {
      retries: 2,
      retryDelay: 100
    });
    const handle = (handler.handle = sandbox.spy(() => {
      throw new Error('test error');
    }));
    const afterDlq = (handler.afterDlq = sandbox.spy());
    await rabbit.publish(this.name, { test: 'data' }, { correlationId: '3' });
    sandbox.clock.tick(100);
    await rabbit.connected;
    sandbox.clock.tick(100);
    await rabbit.connected;
    sandbox.clock.tick(100);
    sandbox.clock.restore();
    await new Promise(resolve => setTimeout(resolve, 300));
    handle.calledThrice.should.be.true();
    afterDlq.calledOnce.should.be.true();
  });

  it('should add to dlq after x retries and get error response', async function() {
    const handler = new DemoHandler(this.name, rabbit, {
      retries: 0,
      retryDelay: 10
    });
    const handle = (handler.handle = sandbox.spy(() => {
      throw new Error('test error');
    }));
    handler.afterDlq = function() {
      return 'response';
    };
    try {
      await rabbit.getReply(this.name, { test: 'data' }, { correlationId: '4' });
    } catch (e) {
      e.should.eql(new Error('test error'));
    }
  });

  it('should add to dlq after x retries and get error response - handles stack missing', async function() {
    const handler = new DemoHandler(this.name, rabbit, {
      retries: 0,
      retryDelay: 10
    });
    const handle = (handler.handle = sandbox.spy(() => {
      throw { foo: 'banana' };
    }));
    handler.afterDlq = function() {
      return 'response';
    };
    try {
      await rabbit.getReply(this.name, { test: 'data' }, { correlationId: '4' });
    } catch (e) {
      e.should.eql({ foo: 'banana' });
    }
  });

  it('should add to dlq after x retries and get no response because afterDlq returns STOP_PROPAGATION', async function() {
    const handler = new DemoHandler(this.name, rabbit, {
      retries: 0,
      retryDelay: 10
    });
    const handle = (handler.handle = sandbox.spy(() => {
      throw new Error('test error');
    }));
    handler.afterDlq = function() {
      return Rabbit.STOP_PROPAGATION;
    };
    try {
      await rabbit.getReply(this.name, { test: 'data' }, { correlationId: '6' }, '', 200);
    } catch (e) {
      e.should.eql(new Error('Timed out'));
    }
  });

  it('should add to dlq after x retries using prototype scope', async function() {
    sandbox.useFakeTimers();
    const handler = DemoHandler.prototypeFactory(this.name, rabbit, {
      retries: 2,
      retryDelay: 100,
      logger: (<any>global).logger
    });
    const handle = DemoHandler.prototype.handle;
    const originalAfterDlq = DemoHandler.prototype.afterDlq;
    DemoHandler.prototype.handle = function({ event }) {
      throw new Error('test error');
    };

    const afterDlq = (DemoHandler.prototype.afterDlq = sandbox.spy());
    await rabbit.publish(this.name, { test: 'data' }, { correlationId: '3' });
    sandbox.clock.tick(100);
    await rabbit.connected;
    sandbox.clock.tick(100);
    await rabbit.connected;
    sandbox.clock.restore();
    sandbox.clock.tick(100);
    await new Promise(resolve => setTimeout(resolve, 400));
    afterDlq.calledOnce.should.be.true();
    DemoHandler.prototype.handle = handle;
    DemoHandler.prototype.afterDlq = originalAfterDlq;
  });

  it('should add string to dlq because afterDlq throws error', async function() {
    sandbox.useFakeTimers();
    const handler = new DemoHandler(this.name, rabbit, {
      retries: 2,
      retryDelay: 100
    });
    handler.handle = sandbox.spy(() => {
      throw new Error('test error');
    });
    let i = 0;
    const afterDlq = (handler.afterDlq = sandbox.spy(() => {
      if (i++ === 0) {
        throw new Error('test error');
      }
    }));
    await rabbit.publish(this.name, { test: 'data' }, { correlationId: '3' });
    const publish = (handler.rabbit.publish = sandbox.spy(handler.rabbit, 'publish'));
    sandbox.clock.tick(100);
    await rabbit.connected;
    sandbox.clock.tick(100);
    await rabbit.connected;
    sandbox.clock.tick(100);
    sandbox.clock.restore();
    await new Promise(resolve => setTimeout(resolve, 400));
    afterDlq.calledOnce.should.be.true();
    publish.calledTwice.should.be.true();
    publish.args[publish.callCount - 1][1].should.eql('{"test":"data"}');
  });

  it('should add to dlq after x retries and get error response even if afterDlq throws error', async function() {
    const handler = new DemoHandler(this.name, rabbit, {
      retries: 0,
      retryDelay: 10
    });
    const handle = (handler.handle = sandbox.spy(() => {
      throw new Error('test error');
    }));
    handler.afterDlq = function() {
      throw new Error('test afterDlq error');
    };
    try {
      await rabbit.getReply(this.name, { test: 'data' }, { correlationId: '4' });
    } catch (e) {
      e.should.eql(new Error('test afterDlq error'));
    }
  });
});
