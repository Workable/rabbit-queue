import { Channel } from './channel';
import * as amqp from 'amqplib';
import { getLogger } from './logger';
import * as assert from 'assert';
import * as uuid from 'uuid';

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

export function getReply(content: any, headers: amqp.Options.Publish, channel: Channel, cb: Function) {
  return new Promise((resolve, reject) => {
    var msg = JSON.stringify(content);
    var correlationId = headers.correlationId || uuid.v4();
    headers = Object.assign({
      persistent: false,
      correlationId,
      replyTo: channel.replyName
    }, headers);
    const bufferContent = new Buffer(msg);
    addHandler(correlationId, (err, body) => err ? reject(err) : resolve(body));
    cb(bufferContent, headers, correlationId, (err, ok) => err ? reject(err) : ({}));
  });
}

function onReply(msg: amqp.Message) {
  const id = msg.properties.correlationId;
  const replyHandler = replyHandlers[id];
  if (!replyHandler) { return; }
  delete replyHandlers[id];

  const body = msg.content.toString();
  getLogger().debug(`[${id}] -> Returning reply ${msg.content.byteLength} bytes`);
  const obj = JSON.parse(body);
  replyHandler(null, obj);
};
