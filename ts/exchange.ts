import * as amqp from 'amqplib';
import {Channel} from './channel';
import {getLogger} from './logger';

export default {
  defaultHeaders: {
    persistent: true
  },

  publish(channel: Channel, exchange: string, routingKey: string, content: any, headers: amqp.Options.Publish) {
    return new Promise((resolve, reject) => {
      let extraHeaders: any = {};
      const bufferContent = new Buffer(JSON.stringify(content));
      const exchangeHeaders: amqp.Options.Publish = Object.assign({}, this.defaultHeaders, headers, extraHeaders);
      getLogger().debug(`[${exchangeHeaders.correlationId}] <- Publishing to ${exchange} ${routingKey} ${bufferContent.byteLength} bytes`);
      channel.publish(exchange, routingKey, bufferContent, exchangeHeaders, (err, ok) => {
        err ? reject(err) : resolve(ok);
      });
    });
  }
};
