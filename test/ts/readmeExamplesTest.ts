import 'should';
import * as assert from 'assert';
import * as sinon from 'sinon';
import Exchange from '../../js/exchange';
import Rabbit from '../../js/rabbit';
import BaseQueueHandler from '../../js/baseQueueHandler';
import * as log4js from 'log4js';

describe('Test Readme examples', function () {
  afterEach(async function () {
    const rabbit = new Rabbit(process.env.RABBIT_URL || 'amqp://localhost');
    await rabbit.destroyQueue('queueName');
    await rabbit.destroyQueue('demoQueue');
    await rabbit.destroyQueue('demoQueue_dlq');
  });
  it('test usage examples', async function () {
    const rabbit = new Rabbit(process.env.RABBIT_URL || 'amqp://localhost');
    await rabbit.createQueue('queueName', { durable: false }, (msg, ack) => {
      console.log(msg.content.toString());
      ack('response');
    }).then(() => console.log('queue created'));

    await rabbit.publish('queueName', { test: 'data' }, { correlationId: '1' })
      .then(() => console.log('message published'));

    await rabbit.getReply('queueName', { test: 'data' }, { correlationId: '1' })
      .then((reply) => console.log('received reply', reply));
  });

  it('test binding examples', async function () {
    const rabbit = new Rabbit(process.env.RABBIT_URL || 'amqp://localhost');
    await rabbit.createQueue('queueName', { durable: false }, (msg, ack) => {
      console.log(msg.content.toString());
      ack('response');
    }).then(() => console.log('queue created'));

    await rabbit.bindToExchange('queueName', 'amq.topic', 'routingKey');
    //shortcut await rabbit.bindToTopic('queueName', 'routingKey');
    await rabbit.publishExchange('amq.topic', 'routingKey', { test: 'data' }, { correlationId: '1' })
      .then(() => console.log('message published'));
    //shortcut await rabbit.publishTopic( 'routingKey', { test: 'data' }, { correlationId: '1' });
  });

  it('test advanced usage', async function () {
    const rabbit = new Rabbit(process.env.RABBIT_URL || 'amqp://localhost');
    class DemoHandler extends BaseQueueHandler {
      handle({msg, event, correlationId, startTime}) {
        console.log('Received: ', event);
        console.log('With correlation id: ' + correlationId);
      }

      afterDlq({msg, event}) {
        // Something to do after added to dlq
      }
    }

    new DemoHandler('demoQueue', rabbit,
      {
        retries: 3,
        retryDelay: 1000,
        logEnabled: true,
        logger: log4js.getLogger('[demoQueue]')
      });

    await rabbit.publish('demoQueue', { test: 'data' }, { correlationId: '4' });
  });
});
