# Rabbit Queue

```
   ,---.     |    |    o|        ,---.
   |---',---.|---.|---..|---     |   |.   .,---..   .,---.
   |  \ ,---||   ||   |||        |   ||   ||---'|   ||---'
   `   ``---^`---'`---'``---'    `---\`---'`---'`---'`---'
```

## About

This module is based on [WRabbit](https://github.com/Workable/wrabbit)
and [Jackrabbit](https://github.com/hunterloftis/jackrabbit).

It makes [RabbitMQ](http://www.rabbitmq.com/) management and integration easy. Provides an abstraction layer
above [amqplib](https://github.com/squaremo/amqp.node).

It is written in typescript and requires node v6.0.0 or higher.

By default it works weel with jsons. Ovewrite properties.conentType to work with strings or binary data.

## Connecting to RabbitMQ

```javascript
const { Rabbit } = require('rabbit-queue');
const rabbit = new Rabbit(process.env.RABBIT_URL || 'amqp://localhost', {
  prefetch: 1, //default prefetch from queue
  replyPattern: true, //if reply pattern is enabled an exclusive queue is created
  scheduledPublish: false,
  prefix: '', //prefix all queues with an application name
  socketOptions: {} // socketOptions will be passed as a second param to amqp.connect and from ther to the socket library (net or tls)
});

rabbit.on('connected', () => {
  //create queues, add halders etc.
  //this will be called on every reconnection too
});

rabbit.on('disconnected', (err = new Error('Rabbitmq Disconnected')) => {
  //handle disconnections and try to reconnect
  console.error(err);
  setTimeout(() => rabbit.reconnect(), 100);
});
```

## Usage

```javascript
const { Rabbit } = require('rabbit-queue');
const rabbit = new Rabbit(process.env.RABBIT_URL || 'amqp://localhost', { scheduledPublish: true });

rabbit
  .createQueue('queueName', { durable: false }, (msg, ack) => {
    console.log(msg.content.toString());
    ack(null, 'response');
  })
  .then(() => console.log('queue created'));

rabbit.publish('queueName', { test: 'data' }, { correlationId: '1' }).then(() => console.log('message published'));

// Please note that a queue will be created for each different expiration used:  prefix_delay_expiration.
rabbit
  .publishWithDelay('queueName', { test: 'data' }, { correlationId: '1', expiration: '10000' })
  .then(() => console.log('message will be published'));

rabbit
  .getReply('queueName', { test: 'data' }, { correlationId: '1' })
  .then(reply => console.log('received reply', reply));

rabbit
  .getReply('queueName', { test: 'data' }, { correlationId: '1' }, '', 100)
  .then(reply => console.log('received reply', reply))
  .catch(error => console.log('Timed out after 100ms'));

rabbit.bindToTopic('queueName', 'routingKey');
rabbit
  .getTopicReply('routingKey', { test: 'data' }, { correlationId: '1' }, '', 100)
  .then(reply => console.log('received reply', reply))
  .catch(error => console.log('Timed out after 100ms'));
```

## Binding to topics

```javascript
const { Rabbit } = require('rabbit-queue');
const rabbit = new Rabbit('amqp://localhost');

rabbit
  .createQueue('queueName', { durable: false }, (msg, ack) => {
    console.log(msg.content.toString());
    ack(null, 'response');
  })
  .then(() => console.log('queue created'));

rabbit.bindToExchange('queueName', 'amq.topic', 'routingKey');
//shortcut rabbit.bindToTopic('queueName', 'routingKey');

rabbit
  .publishExchange('amq.topic', 'routingKey', { test: 'data' }, { correlationId: '1' })
  .then(() => console.log('message published'));
//shortcut rabbit.publishTopic( 'routingKey', { test: 'data' }, { correlationId: '1' });
```

## Advanced Usage with BaseQueueHandler (will add to dlq after 3 failed retries)

```javascript
const rabbit = new Rabbit('amqp://localhost');
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
  logEnabled: true, //log queue processing time
  scope: 'SINGLETON', //can also be 'PROTOTYPE' to create a new instance every time
  createAndSubscribeToQueue: true // used internally no need to overwriteÏÏ
});

rabbit.publish('demoQueue', { test: 'data' }, { correlationId: '4' });
```

### Get reply pattern implemented with a QueueHandler

```javascript
const rabbit = new Rabbit(process.env.RABBIT_URL || 'amqp://localhost');
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
  scope: 'SINGLETON'
});

rabbit
  .getReply('demoQueue', { test: 'data' }, { correlationId: '5' })
  .then(reply => console.log('received reply', reply));
```

### Example where handle throws an error

```javascript
  const rabbit = new Rabbit(process.env.RABBIT_URL || 'amqp://localhost');
  class DemoHandler extends BaseQueueHandler {
    handle({msg, event, correlationId, startTime}) {
      return Promise.reject(new Error('test Error'));  // could be synchronous: throw new Error('test error');
    }

    afterDlq({msg, event}) {
      console.log('added to dlq');
    }
  }

  new DemoHandler('demoQueue', rabbit,
    {
      retries: 3,
      retryDelay: 1,
      logEnabled: true
    });

  rabbit.getReply('demoQueue', { test: 'data' }, { correlationId: '5' })
    .then(reply => console.log('received reply', reply));
    .catch(error => console.log('error', error)); //error will be 'test Error';
```

### Example with Stream rpc (works if both consumer and producer user rabbit-queue)

```javascript
    const rabbit = new Rabbit(process.env.RABBIT_URL || 'amqp://localhost');
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
```

### Logging

Rabbit-queue uses log4js-api so you need to install log4js for logging to work.

Creations of queues, bindings are logged in debug level.
Message enqueues, dequeues are logged in info level.
Errors in BaseQueueHandler are logged in error level. (You can add your own error logging logic in afterDlq method.)

Using log4js v2 and custom appenders like [log4js_honeybadger_appender](https://www.npmjs.com/package/log4js_honeybadger_appender) you can directly log rabbit-queue errors directly to honeybadger.

log4js configuration example

```javascript
log4js.configure({
  appenders: {
    out: { type: 'stdout', layout: { type: 'basic' } }
  },
  honeybadger: { type: 'log4js_honeybadger_appender' },
  categories: {
    default: { appenders: ['out'], level: 'info' },
    'rabbit-queue': { appenders: ['out', 'honeybadger'], level: 'debug' }
  }
});
```

### Changelog

### v2.x.x to v3.x.x

Log4js was removed. You can no longer pass your own logger in Rabbit constructor. Instead log4js-api is used and your log4js configuration is used by default if present. Logger name is rabbit-queue.

#### v1.x.x to V2.x.x

Queue subscribe 2ond param `ack` was updated. Now it accepts as 1st param an error and as a second the response. Rpc calls will throw an error if the first param is defined.

## Tests

The tests are set up with Docker + Docker-Compose,
so you don't need to install rabbitmq (or even node) to run them:

`npm run test-docker`
