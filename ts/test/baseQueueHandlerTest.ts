import * as should from 'should';
import * as assert from 'assert';
import * as sinon from 'sinon';
import Rabbit from '../rabbit';
import BaseQueueHandler from '../baseQueueHandler';
const sandbox = sinon.sandbox.create();

describe('Test baseQueueHandler', function () {
  let rabbit: Rabbit;

  class DemoHandler extends BaseQueueHandler {
    handle({msg, event, correlationId, startTime}) {
      console.log('Received: ', event);
      console.log('With correlation id: ' + correlationId);
    }

    afterDlq({msg, event}) {
      // Something to do after added to dlq
    }
  };

  before(async function () {
    this.url = process.env.RABBIT_URL || 'amqp://localhost';
    this.name = 'test.queue';
    rabbit = new Rabbit(this.url, { logger: (<any>global).logger });
    await rabbit.connected;
  });

  afterEach(async function () {
    await rabbit.destroyQueue(this.name);
    await rabbit.destroyQueue(this.name + '_dlq');
    sandbox.restore();
  });

  it('should handle message', async function () {
    const handler = new DemoHandler(this.name, rabbit, { logger: (<any>global).logger });
    const handle = handler.handle = sandbox.stub();
    await rabbit.publish(this.name, { test: 'data' }, { correlationId: '3' });
    handle.calledOnce.should.be.true();
    handle.args[0][0].event.should.eql({ test: 'data' });
    handle.args[0][0].correlationId.should.equal('3');
  });

  it('should mess context', async function () {
    const handler = new DemoHandler(this.name, rabbit, { logger: (<any>global).logger });
    const handle = handler.handle = function ({event}) {
      this.context = event.test;
    };
    await rabbit.publish(this.name, { test: 'data' }, { correlationId: '3' });
    (<any>handler).context.should.equal('data');
    await rabbit.publish(this.name, { test: 'data2' }, { correlationId: '4' });
    (<any>handler).context.should.equal('data2');
  });

  it('should not mess context', async function () {
    const handle = DemoHandler.prototype.handle;
    DemoHandler.prototype.handle = function ({event}) {
      this.context = event;
    };
    const handler = DemoHandler.prototypeFactory(this.name, rabbit, { logger: (<any>global).logger });
    await rabbit.publish(this.name, { test: 'data' }, { correlationId: '3' });
    should.equal(undefined, (<any>handler).context);
    await rabbit.publish(this.name, { test: 'data2' }, { correlationId: '3' });
    should.equal(undefined, this.context);
    DemoHandler.prototype.handle = handle;
  });

  it('should add to dlq after x retries', async function () {
    sandbox.useFakeTimers();
    const handler = new DemoHandler(this.name, rabbit,
      {
        retries: 2, retryDelay: 100,
        logger: (<any>global).logger
      });
    const handle = handler.handle = sandbox.spy(() => {
      throw new Error('test error');
    });
    const afterDlq = handler.afterDlq = sandbox.spy();
    await rabbit.publish(this.name, { test: 'data' }, { correlationId: '3' });
    sandbox.clock.tick(100);
    await rabbit.connected;
    sandbox.clock.tick(100);
    await rabbit.connected;
    sandbox.clock.restore();
    await new Promise(resolve => setTimeout(resolve, 200));
    handle.calledThrice.should.be.true();
    afterDlq.calledOnce.should.be.true();
  });

  it('should add to dlq after x retries', async function () {
    sandbox.useFakeTimers();
    const handler = DemoHandler.prototypeFactory(this.name, rabbit,
      {
        retries: 2, retryDelay: 100,
        logger: (<any>global).logger
      });
    const handle = DemoHandler.prototype.handle;
    const originalAfterDlq = DemoHandler.prototype.afterDlq
    DemoHandler.prototype.handle = function ({event}) {
      throw new Error('test error');
    };

    const afterDlq = DemoHandler.prototype.afterDlq = sandbox.spy();
    await rabbit.publish(this.name, { test: 'data' }, { correlationId: '3' });
    sandbox.clock.tick(100);
    await rabbit.connected;
    sandbox.clock.tick(100);
    await rabbit.connected;
    sandbox.clock.restore();
    await new Promise(resolve => setTimeout(resolve, 200));
    afterDlq.calledOnce.should.be.true();
    DemoHandler.prototype.handle = handle;
    DemoHandler.prototype.afterDlq = originalAfterDlq;
  });


  it('should add string to dlq because afterDlq throws error', async function () {
    sandbox.useFakeTimers();
    const handler = new DemoHandler(this.name, rabbit,
      {
        retries: 2, retryDelay: 100,
        logger: (<any>global).logger
      });
    handler.handle = sandbox.spy(() => {
      throw new Error('test error');
    });
    let i = 0;
    const afterDlq = handler.afterDlq = sandbox.spy(() => {
      if (i++ === 0) {
        throw new Error('test error');
      }
    });
    await rabbit.publish(this.name, { test: 'data' }, { correlationId: '3' });
    sandbox.clock.tick(100);
    await rabbit.connected;
    sandbox.clock.tick(100);
    await rabbit.connected;
    sandbox.clock.restore();
    const publish = handler.rabbit.publish = sandbox.spy(handler.rabbit, 'publish');
    await new Promise(resolve => setTimeout(resolve, 200));
    afterDlq.calledOnce.should.be.true();
    publish.args[0][1].should.eql('{"test":"data"}');
  });

});
