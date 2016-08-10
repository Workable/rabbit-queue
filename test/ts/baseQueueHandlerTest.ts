import 'should';
import * as assert from 'assert';
import * as sinon from 'sinon';
import Exchange from '../../js/exchange';
import Rabbit from '../../js/rabbit';
import BaseQueueHandler from '../../js/baseQueueHandler';
const sandbox = sinon.sandbox.create();

describe('Test baseQueueHandler', function () {
  let DemoHandler, rabbit: Rabbit;
  before(async function () {
    DemoHandler = class DemoHandler extends BaseQueueHandler {
      handle({msg, event, correlationId, startTime}) {
        console.log('Received: ', event);
        console.log('With correlation id: ' + correlationId);
      }

      afterDlq({msg, event}) {
        // Something to do after added to dlq
      }
    };
    this.url = process.env.RABBIT_URL || 'amqp://localhost';
    this.name = 'test.queue';
    rabbit = new Rabbit(this.url);
    await rabbit.connected;
  });

  afterEach(async function () {
    await rabbit.destroyQueue(this.name);
    await rabbit.destroyQueue(this.name + '_dlq');
    sandbox.restore();
  });

  it('should handle message', async function () {
    const handler = new DemoHandler(this.name, rabbit);
    handler.handle = sandbox.stub();
    await rabbit.publish(this.name, { test: 'data' }, { correlationId: '3' });
    handler.handle.calledOnce.should.be.true();
    handler.handle.args[0][0].event.should.eql({ test: 'data' });
    handler.handle.args[0][0].correlationId.should.equal('3');
  });

  it('should add to dlq after x retries', async function () {
    sandbox.useFakeTimers();
    const emptyfn = () => ({});
    const handler = new DemoHandler(this.name, rabbit,
      {
        retries: 2, retryDelay: 100,
        logger: { debug: emptyfn, warn: emptyfn, error: emptyfn }
      });
    handler.handle = sandbox.spy(() => {
      throw new Error('test error');
    });
    handler.afterDlq = sandbox.spy();
    await rabbit.publish(this.name, { test: 'data' }, { correlationId: '3' });
    sandbox.clock.tick(100);
    await rabbit.connected;
    sandbox.clock.tick(100);
    await rabbit.connected;
    sandbox.clock.restore();
    await new Promise(resolve => setTimeout(resolve, 200));
    handler.handle.calledThrice.should.be.true();
    handler.afterDlq.calledOnce.should.be.true();
  });

  it('should add to dlq after x+1 retries because afterDlq throws error', async function () {
    sandbox.useFakeTimers();
    const emptyfn = () => ({});
    const handler = new DemoHandler(this.name, rabbit,
      {
        retries: 2, retryDelay: 100,
        logger: { debug: emptyfn, warn: emptyfn, error: emptyfn }
      });
    handler.handle = sandbox.spy(() => {
      throw new Error('test error');
    });
    let i = 0;
    handler.afterDlq = sandbox.spy(() => {
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
    await new Promise(resolve => setTimeout(resolve, 200));
    handler.afterDlq.calledTwice.should.be.true();
  });

});
