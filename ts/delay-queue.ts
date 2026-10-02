import { Channel } from './channel';
import * as amqp from 'amqplib';
import Queue from './queue';
import { decode } from './encode-decode';
import getLogger from './logger';

const logger = getLogger('rabbit-queue');
let delayedQueue: { [key: string]: Queue } = {};
let delayedQueueReply: Queue;
let delayedQueueNameReply: string;

export async function createDelayQueueReply(channel: Channel, delayedQueueName: string, createAsQuorum: boolean = false) {
  delayedQueueNameReply = createAsQuorum ? `${delayedQueueName}_quorum_reply` : `${delayedQueueName}_reply`;
  delayedQueueReply = new Queue(channel, delayedQueueNameReply, { ...createAsQuorum && {
      arguments: {
        'x-dead-letter-strategy': 'at-least-once',
        'x-queue-type': 'quorum',
      },
      overflow: 'reject-publish'
    } });
  await delayedQueueReply.created;
  delayedQueueReply.subscribe(onMessage(channel));
}

export async function createDelayQueue(channel: Channel, delayedQueueName: string, createAsQuorum: boolean = false) {
  delayedQueue[delayedQueueName] = new Queue(channel, delayedQueueName, {
    deadLetterExchange: '',
    deadLetterRoutingKey: delayedQueueNameReply,
    ...createAsQuorum && {
      arguments: {
        'x-dead-letter-strategy': 'at-least-once',
        'x-queue-type': 'quorum',
      },
      overflow: 'reject-publish'
    }
  });
  await delayedQueue[delayedQueueName].created;
}

export async function publishWithDelay(
  name,
  obj,
  headers: amqp.Options.Publish = {},
  channel: Channel,
  queueName: string,
  createAsQuorum: boolean = false
) {
  const { expiration = '10000' } = headers || {};
  name = `${name}_${expiration}`;

  if (!delayedQueue[name]) {
    await createDelayQueue(channel, name, createAsQuorum);
  }
  const timestamp = new Date().getTime();
  Queue.publish(
    { queueName, obj, timestamp },
    { expiration, ...headers, contentType: 'application/json' },
    channel,
    delayedQueue[name].name,
    delayedQueue[name]
  );
}

function onMessage(channel: Channel) {
  return async (msg: amqp.Message, ack) => {
    const id = msg.properties.correlationId;
    const { queueName, obj, timestamp } = decode(msg);
    const { properties } = msg;
    const { ['x-death']: xDeath, ...rest } = properties.headers;
    logger.debug(`[${id}] -> Received expired msg after ${xDeath[0]['original-expiration']} ms. \
Actually took ${new Date().getTime() - timestamp} ms.`);
    await Queue.publish(obj, { ...properties, headers: rest }, channel, queueName);
    ack();
  };
}
