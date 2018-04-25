import { Channel } from './channel';
import * as amqp from 'amqplib';
import * as assert from 'assert';
import * as uuid from 'uuid';
import Queue from './queue';
import * as log4js from '@log4js-node/log4js-api';

const logger = log4js.getLogger('rabbit-queue');
let replyHandlers = {};

export async function createReplyQueue(channel: Channel) {
  await channel.assertQueue('', { exclusive: true }).then(replyTo => {
    channel.replyName = replyTo.queue;
    channel.consume(channel.replyName, onReply, { noAck: true });
  });
}

export function addHandler(correlationId, handler: (err: Error, body: string) => void) {
  assert(!replyHandlers[correlationId], `Already added reply handler with this id: ${correlationId}.`);
  replyHandlers[correlationId] = handler;
}

export function getReply(content: any, headers: amqp.Options.Publish, channel: Channel, cb: Function) {
  return new Promise((resolve, reject) => {
    var msg = JSON.stringify(content);
    var correlationId = headers.correlationId || uuid.v4();
    headers = Object.assign(
      {
        persistent: false,
        correlationId,
        replyTo: channel.replyName
      },
      headers
    );
    const bufferContent = new Buffer(msg);
    addHandler(correlationId, (err, body) => (err ? reject(err) : resolve(body)));
    cb(bufferContent, headers, correlationId, (err, ok) => (err ? reject(err) : {}));
  });
}

function onReply(msg: amqp.Message) {
  const id = msg.properties.correlationId;
  const replyHandler = replyHandlers[id];
  if (!replyHandler) {
    logger.error(`No reply Handler found for ${id}`);
    return;
  }
  delete replyHandlers[id];

  const body = msg.content.toString();
  logger.info(`[${id}] -> Returning reply ${msg.content.byteLength} bytes`);
  const obj = JSON.parse(body);
  if (obj && obj.error && obj.error_code === Queue.ERROR_DURING_REPLY.error_code) {
    replyHandler(new Error(obj.error_message), null);
  } else {
    replyHandler(null, obj);
  }
}
