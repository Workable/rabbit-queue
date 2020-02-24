/* tslint:disable:no-unused-expression */
import 'should';
import * as assert from 'assert';
import * as sinon from 'sinon';
import Exchange from '../ts/exchange';
import Rabbit from '../ts/rabbit';
import BaseQueueHandler from '../ts/base-queue-handler';
import { Readable } from 'stream';
const sandbox = sinon.createSandbox();

describe('Test Readme examples', function() {
  let rabbit: Rabbit;
  before(function() {
    sandbox.stub(console, 'error');
    sandbox.stub(console, 'log');
  });

  after(function() {
    sandbox.restore();
  });

  afterEach(async function() {
    await rabbit.destroyQueue('queueName');
    await rabbit.destroyQueue('demoQueue');
    await rabbit.destroyQueue('demoQueue_dlq');
  });

  afterEach(async function() {
    await rabbit.close();
  });

  it('test connecting to rabbitmq', function() {
    rabbit = new Rabbit(process.env.RABBIT_URL || 'amqp://localhost', {
      prefetch: 1, //default prefetch from queue
      replyPattern: true, //if reply pattern is enabled an exclusive queue is created
      scheduledPublish: false,
      prefix: '', //prefix all queues with an application name
      socketOptions: {} // socketOptions will be passed as a second param to amqp.connect and from ther to the socket library (net or tls)
    });

    rabbit.on('connected', () => {
      //create queues, add halders etc.
    });

    rabbit.on('disconnected', (err = new Error('Rabbitmq Disconnected')) => {
      //handle disconnections and try to reconnect
      console.error(err);
      // setTimeout(() => rabbit.reconnect(), 100);
    });
  });

  it('test usage examples', async function() {
    rabbit = new Rabbit(process.env.RABBIT_URL || 'amqp://localhost', { scheduledPublish: true });
    await rabbit
      .createQueue('queueName', { durable: false }, (msg, ack) => {
        console.log(msg.content.toString());
        ack(null, 'response');
      })
      .then(() => console.log('queue created'));

    await rabbit
      .publish('queueName', { test: 'data' }, { correlationId: '1' })
      .then(() => console.log('message published'));

    await rabbit
      .publishWithDelay('queueName', { test: 'data' }, { correlationId: '1', expiration: '10000' })
      .then(() => console.log('message will be published'));

    await rabbit
      .getReply('queueName', { test: 'data' }, { correlationId: '1' })
      .then(reply => console.log('received reply', reply));

    await rabbit
      .getReply('queueName', { test: 'data' }, { correlationId: '1' }, '', 100)
      .then(reply => console.log('received reply', reply))
      .catch(error => console.log('Timed out after 100ms'));

    await rabbit.bindToTopic('queueName', 'routingKey');
    await rabbit
      .getTopicReply('routingKey', { test: 'data' }, { correlationId: '1' }, '', 100)
      .then(reply => console.log('received reply', reply))
      .catch(error => console.log('Timed out after 100ms'));
  });

  it('test binding examples', async function() {
    rabbit = new Rabbit(process.env.RABBIT_URL || 'amqp://localhost');
    await rabbit
      .createQueue('queueName', { durable: false }, (msg, ack) => {
        console.log(msg.content.toString());
        ack(null, 'response');
      })
      .then(() => console.log('queue created'));

    await rabbit.bindToExchange('queueName', 'amq.topic', 'routingKey');
    //shortcut await rabbit.bindToTopic('queueName', 'routingKey');
    await rabbit
      .publishExchange('amq.topic', 'routingKey', { test: 'data' }, { correlationId: '1' })
      .then(() => console.log('message published'));
    //shortcut await rabbit.publishTopic( 'routingKey', { test: 'data' }, { correlationId: '1' });
  });

  it('test advanced usage', async function() {
    rabbit = new Rabbit(process.env.RABBIT_URL || 'amqp://localhost');
    class DemoHandler extends BaseQueueHandler {
      handle({ msg, event, correlationId, startTime }) {
        console.log('Received: ', event);
        console.log('With correlation id: ' + correlationId);
      }

      afterDlq({ msg, event }) {
        // Something to do after added to dlq
      }
    }

    new DemoHandler('demoQueue', rabbit, {
      retries: 3,
      retryDelay: 1000,
      logEnabled: true
    });

    await rabbit.publish('demoQueue', { test: 'data' }, { correlationId: '4' });
  });

  it('test advanced usage with getReply', async function() {
    rabbit = new Rabbit(process.env.RABBIT_URL || 'amqp://localhost');
    class DemoHandler extends BaseQueueHandler {
      handle({ msg, event, correlationId, startTime }) {
        console.log('Received: ', event);
        console.log('With correlation id: ' + correlationId);
        return Promise.resolve('reply'); // could be return 'reply';
      }

      afterDlq({ msg, event }) {
        // Something to do after added to dlq
      }
    }

    new DemoHandler('demoQueue', rabbit, {
      retries: 3,
      retryDelay: 1000,
      logEnabled: true,
      scope: 'SINGLETON', //can also be 'PROTOTYPE' to create a new instance every time
      createAndSubscribeToQueue: true // used internally no need to overwriteÏÏ
    });

    await rabbit
      .getReply('demoQueue', { test: 'data' }, { correlationId: '5' })
      .then(reply => console.log('received reply', reply));
  });

  it('test advanced usage add to dlq', async function() {
    rabbit = new Rabbit(process.env.RABBIT_URL || 'amqp://localhost');
    class DemoHandler extends BaseQueueHandler {
      handle({ msg, event, correlationId, startTime }) {
        return Promise.reject(new Error('test Error')); //throw new Error('test error');
      }

      afterDlq({ msg, event }) {
        console.log('added to dlq');
      }
    }

    new DemoHandler('demoQueue', rabbit, {
      retries: 3,
      retryDelay: 1,
      logEnabled: true,
      scope: 'SINGLETON'
    });

    await rabbit
      .getReply('demoQueue', { test: 'data' }, { correlationId: '5' })
      .then(reply => console.log('received reply', reply))
      .catch(error => console.log('error', error)); //error will be 'test Error';
  });

  it('test example with stream rpc', async function() {
    rabbit = new Rabbit(process.env.RABBIT_URL || 'amqp://localhost');
    if (process.env.SKIP_STREAM) return;
    class DemoHandler extends BaseQueueHandler {
      handle({ msg, event, correlationId, startTime }) {
        const stream = new Readable({ read() {} });
        stream.push('streaming');
        stream.push('events');
        stream.push(null); //the end
        return stream;
      }
    }

    new DemoHandler('demoQueue', rabbit, {
      retries: 3,
      retryDelay: 1,
      logEnabled: true
    });

    const reply = await rabbit.getReply('demoQueue', { test: 'data' }, { correlationId: '5' });
    for await (const chunk of reply) {
      console.log(`Received chunk: ${chunk.toString()}`);
    }
  });
});
