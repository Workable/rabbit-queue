import { Channel } from './channel';
import * as amqp from 'amqplib';
import * as assert from 'assert';
import * as uuid from 'uuid';
import Queue from './queue';
import * as log4js from '@log4js-node/log4js-api';
import { Readable } from 'stream';

const logger = log4js.getLogger('rabbit-queue');
let replyHandlers = {};
let streamHandlers = {};

export async function createReplyQueue(channel: Channel) {
  await channel.assertQueue('', { exclusive: true }).then(replyTo => {
    channel.replyName = replyTo.queue;
    channel.consume(channel.replyName, onReply, { noAck: true });
  });
}

export function addHandler(correlationId, handler: (err: Error, body: string) => void) {
  assert(!replyHandlers[correlationId], `Already added reply handler with this id: ${correlationId}.`);
  assert(!streamHandlers[correlationId], `Already exists stream handler with this id: ${correlationId}.`);
  replyHandlers[correlationId] = handler;
}

export function getReply(content: any, headers: amqp.Options.Publish = {}, channel: Channel, cb: Function) {
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
    const bufferContent = Buffer.from(msg);
    addHandler(correlationId, (err, body) => (err ? reject(err) : resolve(body)));
    cb(bufferContent, headers, correlationId, (err, ok) => (err ? reject(err) : {}));
  });
}

function onReply(msg: amqp.Message) {
  const id = msg.properties.correlationId;
  const headers = msg.properties.headers || {};
  if (headers.isStream) {
    return handleStreamReply(msg, id);
  }
  const replyHandler = replyHandlers[id];
  if (!replyHandler) {
    logger.error(`No reply Handler found for ${id}`);
    return;
  }
  delete replyHandlers[id];

  const body = msg.content.toString();
  logger.info(`[${id}] <- Returning reply ${msg.content.byteLength} bytes`);
  const obj = JSON.parse(body);
  if (obj && obj.error && obj.error_code === Queue.ERROR_DURING_REPLY.error_code) {
    replyHandler(new Error(obj.error_message), null);
  } else {
    replyHandler(null, obj);
  }
}

function handleStreamReply(msg: amqp.Message, id: string) {
  const replyHandler = replyHandlers[id];
  let streamHandler = streamHandlers[id];
  if (replyHandler && streamHandler) {
    delete replyHandlers[id];
    return replyHandler(new Error(`Both replyHandler and StreamHandler exist for id: ${id}`));
  }
  if (!streamHandler) {
    if (!replyHandler) {
      logger.error(`No reply Handler found for ${id}`);
      return;
    }
    delete replyHandlers[id];
    console.log('deleted');
    streamHandler = streamHandlers[id] = new Readable({ objectMode: true, read() {} });
    replyHandler(null, streamHandler);
  }
  const body = msg.content.toString();
  const obj = JSON.parse(body);
  logger.info(`[${id}] <- Returning${obj === null && ' the end of'} stream reply ${msg.content.byteLength} bytes`);
  streamHandler.push(obj);
  if (obj === null) {
    delete streamHandlers[id];
  }
}
