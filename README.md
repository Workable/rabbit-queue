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

It is written in typescript and requires node v10.0.0 or higher.
Most features will work with nodejs v6.0.0 and higher but using older versions than v10.0.0 is not recommended. RPC streams will not work in older versions.

By default it works well with jsons. Override properties.contentType to work with strings or binary data.

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

### Example with Stream rpc (works if both consumer and producer use rabbit-queue)

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

Rabbit-queue logs to console by default.
It also emits events for each log so that you can use your own logger

eg:

```javascript
rabbit.on('log', (component, level, ...args) => console.log(`[${level}] ${component}`, ...args));
```

### Changelog

### v4.x.x to v5.x.x

- Support for Node LTS v6 and v8 was dropped. You should use Node v10 and higher.
- Two connections are created by default to rabbitMQ. One for consuming and one for producing messages.
- Dependency to log4js was dropped. Console is used by default but you can easily plug your own logger.

### New in v4.7.x

When declaring queues with handlers you can define a prefetch count different from the global one

```js
rabbit.createQueue('queueName', { durable: false, prefetch: 100 }, (msg, ack) => {
  console.log(msg.content.toString());
  ack(null, 'response');
});

// or

class DemoHandler extends BaseQueueHandler {
  // ...
}

new DemoHandler('demoQueue', rabbit, { prefetch: 100 });
```

Note that the prefetch value is set to RabbitMQ and if you have other ways of creating consumers eg. by calling queue.subscribe directly you might end up with consumers being created with different prefetch from the global.
The two ways mentioned above are handled by rabbit-queue and they are **synchronized** so that no other queue consumer might be affected.

Also note that if you use rabbit prior to 3.3.0 the behavior might be different.
See https://www.rabbitmq.com/consumer-prefetch.html for more details

### v4.2.x to > v4.4.x

RPC stream enhancement: When backpressure is enabled, the consumer can stop communication, when data received is sufficient

eg:

```js
const reply = await rabbit.getReply(
  'demoQueue',
  { test: 'data' },
  { headers: { test: 1, backpressure: true }, correlationId: '1' }
);
for await (const chunk of reply) {
  console.log(`Received chunk: ${chunk.toString()}`);
  if ('sufficient_data_received') {
    reply.emit(Queue.STOP_STREAM);
  }
}
```

### v4.x.x to > v4.2.x

Get reply as a stream supports two more optional headers inside properties:

backpressure (by default false),
timeout

eg:

```js
await rabbit.getReply(
  'demoQueue',
  { test: 'data' },
  { correlationId: '5', headers: { backpressure: true, timeout: 10000 } }
);
```

If used the rpc that responds to this request will stop sending messages until the receiving stream has consumed those messages or has buffered them (By default nodejs stream buffer for json streams is 16 objects). If this does not happen within the timeout the process will stop.

Use this feature only if both requesting and receiving part have rabbit-queue > 4.2.0

### v3.x.x to v4.x.x

Code was reorganized.
RPC stream was introduced. Drops support for node older than v10.0.0 due to the usage of async generators
Supports contentType. By default it is application/json for backwards compatibility.

### v2.x.x to v3.x.x

Log4js was removed. You can no longer pass your own logger in Rabbit constructor. Instead log4js-api is used and your log4js configuration is used by default if present. Logger name is rabbit-queue.

#### v1.x.x to V2.x.x

Queue subscribe 2ond param `ack` was updated. Now it accepts as 1st param an error and as a second the response. Rpc calls will throw an error if the first param is defined.

## Tests

The tests are set up with Docker + Docker-Compose,
so you don't need to install rabbitmq (or even node) to run them:

`npm run test-docker`
