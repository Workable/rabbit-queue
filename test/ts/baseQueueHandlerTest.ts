import 'should';
import * as assert from 'assert';
import * as sinon from 'sinon';
import Rabbit from '../../js/rabbit';
import BaseQueueHandler from '../../js/baseQueueHandler';
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
    const handle = handler.handle = sandbox.stub();
    await rabbit.publish(this.name, { test: 'data' }, { correlationId: '3' });
    handle.calledOnce.should.be.true();
    handle.args[0][0].event.should.eql({ test: 'data' });
    handle.args[0][0].correlationId.should.equal('3');
  });

  it('should add to dlq after x retries', async function () {
    sandbox.useFakeTimers();
    const emptyfn = () => ({});
    const handler = new DemoHandler(this.name, rabbit,
      {
        retries: 2, retryDelay: 100,
        logger: { debug: emptyfn, warn: emptyfn, error: emptyfn }
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

  it('should add string to dlq because afterDlq throws error', async function () {
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
