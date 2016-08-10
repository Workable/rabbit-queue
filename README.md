# Rabbit Queue

```
   ,---.     |    |    o|        ,---.
   |---',---.|---.|---..|---     |   |.   .,---..   .,---.
   |  \ ,---||   ||   |||        |   ||   ||---'|   ||---'
   `   ``---^`---'`---'``---'    `---\`---'`---'`---'`---'
```

## About

This module is based on [WRabbit](https://github.com/Workable/wrabbit)
and [jackrabbit](https://github.com/hunterloftis/jackrabbit).

It makes rabbitmq managemnent and integration easy. Provides an abstraction layer
above [amqplib](https://github.com/squaremo/amqp.node).

It is written in typescript and requires node v6.0.0 or higher. If you want to use it
with an older version please dowload the sources and build them with target  (`/ts/tsconfig.json`).

## Usage

```
  const {Rabbit} = require('rabbit-queue');

  const rabbit = new Rabbit('amqp://localhost');

  rabbit.createQueue('queueName', { durable: false }, (msg, ack) => {
    console.log(msg.content.toString());
    ack('response');
  }).then(() => console.log('queue created'));

  rabbit.publish('queueName', { test: 'data' }, { correlationId: '1' })
    .then(() => console.log('message published'));

  rabbit.getReply('queueName', { test: 'data' }, { correlationId: '1' })
    .then((reply) => console.log('received reply', reply));

```

## Binding to topics


```
  const {Rabbit} = require('rabbit-queue');
  const rabbit = new Rabbit('amqp://localhost');

  await rabbit.createQueue('queueName', { durable: false }, (msg, ack) => {
    console.log(msg.content.toString());
    ack('response');
  }).then(() => console.log('queue created'));

  await rabbit.bindToExchange('queueName', 'amq.topic', 'routingKey');
  //shortcut await rabbit.bindToTopic('queueName', 'routingKey');

  await rabbit.publishExchange('amq.topic', 'routingKey', { test: 'data' }, { correlationId: '1' })
    .then(() => console.log('message published'));
  //shortcut await rabbit.publishTopic( 'routingKey', { test: 'data' }, { correlationId: '1' });

```

## Advanced Usage with BaseQueueHandler (will add to dlq after 3 failed retries)

```

  const rabbit = new Rabbit('amqp://localhost');

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
      logEnabled: true, //log queue processing time
      logger: log4js.getLogger('[demoQueue]') // logging in debug, warn and error.
    });

  rabbit.publish('demoQueue', { test: 'data' }, { correlationId: '4' });

```

## Tests

The tests are set up with Docker + Docker-Compose,
so you don't need to install rabbitmq (or even node) to run them:

```npm run test-docker```
