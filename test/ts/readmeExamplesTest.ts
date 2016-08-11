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

  it('test connecting to rabbitmq', function () {
    const rabbit = new Rabbit(process.env.RABBIT_URL || 'amqp://localhost', {
      prefetch: 1, //default prefetch from queue
      replyPattern: true, //if reply pattern is enabled an exclusive queue is created
      logger: log4js.getLogger(`Rabbit-queue`),
      prefix: '' //prefix all queues with an application name
    });

    rabbit.on('connected', () => {
      //create queues, add halders etc.
    });

    rabbit.on('disconnected', (err = new Error('Rabbitmq Disconnected')) => {
      //handle disconnections and try to reconnect
      console.error(err);
      setTimeout(() => rabbit.reconnect(), 100);
    });
  })
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


  it('test advanced usage with getReply', async function () {
    const rabbit = new Rabbit(process.env.RABBIT_URL || 'amqp://localhost');
    class DemoHandler extends BaseQueueHandler {
      handle({msg, event, correlationId, startTime}) {
        console.log('Received: ', event);
        console.log('With correlation id: ' + correlationId);
        return Promise.resolve('reply'); // could be return 'reply';
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

    await rabbit.getReply('demoQueue', { test: 'data' }, { correlationId: '5' })
      .then((reply) => console.log('received reply', reply));
  });

  it('test advanced usage add to dlq', async function () {
    const rabbit = new Rabbit(process.env.RABBIT_URL || 'amqp://localhost');
    class DemoHandler extends BaseQueueHandler {
      handle({msg, event, correlationId, startTime}) {
        return Promise.reject(new Error('test Error')); //throw new Error('test error');
      }

      afterDlq({msg, event}) {
        console.log('added to dlq');
      }
    }

    new DemoHandler('demoQueue', rabbit,
      {
        retries: 3,
        retryDelay: 1,
        logEnabled: true,
        logger: log4js.getLogger('[demoQueue]')
      });

    await rabbit.getReply('demoQueue', { test: 'data' }, { correlationId: '5' })
      .then((reply) => console.log('received reply', reply)); //reply will be '';
  })
});
