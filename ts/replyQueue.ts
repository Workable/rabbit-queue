import {Channel} from './channel';
import * as amqp from 'amqplib';
import {getLogger} from './logger';
import * as assert from 'assert';
let replyHandlers = {};

export async function createReplyQueue(channel: Channel) {
  await channel.assertQueue('', { exclusive: true })
    .then((replyTo) => {
      channel.replyName = replyTo.queue;
      channel.consume(channel.replyName, onReply, { noAck: true });
    });
};

export function addHandler(correlationId, handler: (err: Error, body: string) => void) {
  assert(!replyHandlers[correlationId], 'Already added reply handler with this id.');
  replyHandlers[correlationId] = handler;
}

function onReply(msg: amqp.Message) {
  const id = msg.properties.correlationId;
  const replyHandler = replyHandlers[id];
  if (!replyHandler) { return; }
  delete replyHandlers[id];

  const body = msg.content.toString();
  getLogger().debug(`<- Returning reply ${msg.content.byteLength} bytes`);
  const obj = JSON.parse(body);
  replyHandler(null, obj);
};
