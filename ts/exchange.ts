import * as amqp from 'amqplib';
import { Channel } from './channel';
import { raceUntil } from 'race-until';
import { getReply } from './reply-queue';
import { encode } from './encode-decode';
import * as uuid from 'uuid';
import getLogger from './logger';

const logger = getLogger('rabbit-queue');
export default {
  defaultHeaders: {
    persistent: true
  },

  publish(channel: Channel, exchange: string, routingKey: string, content: any, properties: amqp.Options.Publish = {}) {
    return new Promise((resolve, reject) => {
      const correlationId = properties.correlationId || uuid.v4();
      const bufferContent = encode(content, properties.contentType);
      const exchangeHeaders: amqp.Options.Publish = Object.assign({ correlationId }, this.defaultHeaders, properties);
      logger.debug(`[${correlationId}] -> Publishing to ${exchange} ${routingKey} ${bufferContent.byteLength} bytes`);
      channel.publish(exchange, routingKey, bufferContent, exchangeHeaders, (err, ok) => {
        err ? reject(err) : resolve(ok);
      });
    });
  },

  async getReply(
    channel: Channel,
    exchange: string,
    routingKey: string,
    content: any,
    properties: amqp.Options.Publish,
    timeout?: number
  ) {
    const reply = getReply(content, properties, channel, (bufferContent, headers, correlationId, cb) => {
      logger.debug(
        `[${correlationId}] -> Publishing to reply exchange ${exchange}-${routingKey} ${bufferContent.byteLength} bytes`
      );
      channel.publish(exchange, routingKey, bufferContent, headers, cb);
    });
    if (timeout) {
      return raceUntil(reply, timeout, new Error('Timed out'));
    } else {
      return reply;
    }
  }
};
