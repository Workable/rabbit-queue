import * as amqp from 'amqplib';
import { Channel } from './channel';
import raceUntil from 'race-until';
import { getReply } from './replyQueue';
import * as log4js from '@log4js-node/log4js-api';

const logger = log4js.getLogger('rabbit-queue');
export default {
  defaultHeaders: {
    persistent: true
  },

  publish(channel: Channel, exchange: string, routingKey: string, content: any, headers: amqp.Options.Publish) {
    return new Promise((resolve, reject) => {
      let extraHeaders: any = {};
      const bufferContent = new Buffer(JSON.stringify(content));
      const exchangeHeaders: amqp.Options.Publish = Object.assign({}, this.defaultHeaders, headers, extraHeaders);
      logger.info(
        `[${exchangeHeaders.correlationId}] -> Publishing to ${exchange} ${routingKey} ${
          bufferContent.byteLength
        } bytes`
      );
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
    headers: amqp.Options.Publish,
    timeout?: number
  ) {
    const reply = getReply(content, headers, channel, (bufferContent, headers, correlationId, cb) => {
      logger.info(
        `[${correlationId}] -> Publishing to reply exchange ${exchange}-${routingKey} ${bufferContent.byteLength} bytes`
      );
      channel.publish(exchange, routingKey, bufferContent, headers, cb);
    });
    if (timeout) {
      return raceUntil(reply, timeout, false);
    } else {
      return reply;
    }
  }
};
