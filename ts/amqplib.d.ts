import 'amqplib';

// @types/amqplib's Options.AssertQueue is missing fields RabbitMQ supports (overflow, queueMode);
// patch them in here until the upstream typings catch up.
declare module 'amqplib/properties' {
  namespace Options {
    interface AssertQueue {
      overflow?: string;
      queueMode?: string;
    }
  }
}
