import { Channel } from './channel';
import * as amqp from 'amqplib';
import { getLogger } from './logger';
import * as assert from 'assert';
import * as uuid from 'uuid';
import Queue from './queue';

let delayedQueue: Queue;
let delayedQueueReply: Queue;

export async function createDelayQueue(channel: Channel, delayedQueueName: string) {
  delayedQueue = new Queue(channel, delayedQueueName, {
    deadLetterExchange: 'amq.direct',
    deadLetterRoutingKey: `${name}_delay_reply`,
    durable: true
  });
  await delayedQueue.created;

  delayedQueueReply = new Queue(channel, `${delayedQueueName}_reply`, { durable: true });
  await delayedQueueReply.created;
  delayedQueueReply.subscribe(onReply(channel));
};

export async function publishWithDelay(obj, headers: amqp.Options.Publish = {}, channel: Channel, name: string) {
  Queue.publish({ name, obj }, headers, channel, delayedQueue.name, delayedQueue);
}

function onReply(channel: Channel) {
  return (msg: amqp.Message) => {
    const id = msg.properties.correlationId;
    const body = msg.content.toString();
    getLogger().debug(`[${id}] -> Returning reply ${msg.content.byteLength} bytes`);
    const {name, obj} = JSON.parse(body);
    const {expiration, ...headers} = msg.properties.headers;
    Queue.publish(obj, headers, channel, name);
  }
};
