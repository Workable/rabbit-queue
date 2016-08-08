import * as amqp from 'amqplib';

export interface Channel extends amqp.Channel {
  sendToQueue(queue: string, content: Buffer, options?: amqp.Options.Publish, cb?: Function): boolean;
  publish(exchange: string, routingKey: string, content: Buffer, options?: amqp.Options.Publish, cb?: Function): boolean;
  replyName?: string;
}
