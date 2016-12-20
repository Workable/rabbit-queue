import { Channel } from './channel';
import * as amqp from 'amqplib';
import { getLogger } from './logger';
import Queue from './queue';

let delayedQueue: Queue;
let delayedQueueReply: Queue;

export async function createDelayQueue(channel: Channel, delayedQueueName: string) {
  const delayedQueueNameReply = `${delayedQueueName}_reply`;
  delayedQueue = new Queue(channel, delayedQueueName, {
    deadLetterExchange: '',
    deadLetterRoutingKey: delayedQueueNameReply
  });
  await delayedQueue.created;

  delayedQueueReply = new Queue(channel, delayedQueueNameReply, {});
  delayedQueueReply.subscribe(onMessage(channel));
};

export async function publishWithDelay(obj, headers: amqp.Options.Publish = {}, channel: Channel, queueName: string) {
  Queue.publish({ queueName, obj }, { expiration: '10000', ...headers }, channel, delayedQueue.name, delayedQueue);
}

function onMessage(channel: Channel) {
  return async (msg: amqp.Message, ack) => {
    const id = msg.properties.correlationId;
    const body = msg.content.toString();
    const {queueName, obj} = JSON.parse(body);
    const {properties} = msg;
    const {['x-death']: xDeath, ...rest} = properties.headers;
    getLogger().debug(`[${id}] -> Received expired msg after ${xDeath[0]['original-expiration']} ms`);
    await Queue.publish(obj, { ...properties, headers: rest }, channel, queueName);
    ack();
  };
};