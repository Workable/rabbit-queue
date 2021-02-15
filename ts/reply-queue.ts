import { Channel } from './channel';
import * as amqp from 'amqplib';
import * as assert from 'assert';
import * as uuid from 'uuid';
import Queue from './queue';
import { Readable } from 'stream';
import { decode, encode } from './encode-decode';
import getLogger from './logger';

const logger = getLogger('rabbit-queue');
let replyHandlers = {};
let streamHandlers = {};
let stopped = {};
let options: { channel: Channel } = { channel: null };

export async function createReplyQueue(channel: Channel) {
  await channel.assertQueue('', { exclusive: true }).then(replyTo => {
    channel.replyName = replyTo.queue;
    options.channel = channel;
    channel.consume(channel.replyName, onReply, { noAck: true });
  });
}

export function addHandler(correlationId, handler: (err: Error, body: string) => void) {
  assert(!replyHandlers[correlationId], `Already added reply handler with this id: ${correlationId}.`);
  assert(!streamHandlers[correlationId], `Already exists stream handler with this id: ${correlationId}.`);
  replyHandlers[correlationId] = handler;
}

export function getReply(content: any, properties: amqp.Options.Publish = {}, channel: Channel, cb: Function) {
  return new Promise((resolve, reject) => {
    var correlationId = properties.correlationId || uuid.v4();
    properties = Object.assign(
      {
        persistent: false,
        correlationId,
        replyTo: options.channel.replyName,
        contentType: 'application/json'
      },
      properties
    );
    const bufferContent = encode(content, properties.contentType);
    addHandler(correlationId, (err, body) => (err ? reject(err) : resolve(body)));
    cb(bufferContent, properties, correlationId, (err, ok) => (err ? reject(err) : {}));
  });
}

function onReply(msg: amqp.Message) {
  const id = msg.properties.correlationId;
  const headers = msg.properties.headers || {};
  if (headers.isStream) {
    return handleStreamReply(msg, headers.correlationId);
  }
  const replyHandler = replyHandlers[id];
  if (!replyHandler) {
    logger.error(`No reply Handler found for ${id}`);
    return;
  }
  delete replyHandlers[id];

  logger.debug(`[${id}] <- Returning reply ${msg.content.byteLength} bytes`);
  const obj = decode(msg);
  if (obj && obj.error && obj.error_code === Queue.ERROR_DURING_REPLY.error_code) {
    replyHandler(new Error(obj.error_message), null);
  } else {
    replyHandler(null, obj);
  }
}

function handleStreamReply(msg: amqp.Message, id: string) {
  const correlationId = msg.properties.correlationId;
  const replyHandler = replyHandlers[id];
  let streamHandler = streamHandlers[id];
  let backpressure = false;
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
    streamHandler = new Readable({
      objectMode: true,
      read() {
        backpressure = false;
        if (options[id]) {
          const { replyTo, properties } = options[id];
          if (replyTo) options.channel.sendToQueue(replyTo, encode({ backpressure: true }), properties);
          delete options[id];
        }
      }
    });
    streamHandler.on(Queue.STOP_STREAM, () => {
      stopped[id] = true;
    });
    streamHandlers[id] = streamHandler;
    replyHandler(null, streamHandler);
  }
  const obj = decode(msg);

  if (obj && obj.error && obj.error_code === Queue.ERROR_DURING_REPLY.error_code) {
    delete streamHandlers[id];
    return setImmediate(() => streamHandler.destroy(new Error(obj.error_message)));
  }
  logger.debug(
    `[${correlationId}] <- Returning${(obj === null && ' the end of') || ''} stream reply ${
      msg.content.byteLength
    } bytes`
  );
  const properties = {
    correlationId,
    contentType: 'application/json',
    persistent: false
  };

  if (stopped[id]) {
    options.channel.sendToQueue(
      msg.properties.replyTo,
      Buffer.from(JSON.stringify(Queue.STOP_STREAM_MESSAGE)),
      properties
    );
    streamHandler.push(null);
    delete options[id];
    delete stopped[id];
    delete streamHandlers[id];
    logger.debug(
      `[${correlationId}] <- Returning (stop event received) the end of stream reply ${msg.content.byteLength} bytes`
    );
    return;
  }

  // Push to queue after checking if it is stopped in order to "discard" anything received after stopStream event emission
  backpressure = !streamHandler.push(obj);

  if (backpressure) {
    options[id] = { replyTo: msg.properties.replyTo, properties };
  } else if (msg.properties.replyTo) {
    options.channel.sendToQueue(msg.properties.replyTo, encode(null), properties);
  }
  if (obj === null) {
    delete streamHandlers[id];
  }
}
