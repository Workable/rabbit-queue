import getLogger from './logger';
import * as amqp from 'amqplib';
import { Channel } from './channel';
import Queue from './queue';

export class Migrator {
  public logger: ReturnType<typeof getLogger>;

  constructor(private connection: amqp.ChannelModel) {
    this.logger = getLogger('rabbit-queue.migrator');
  }

  async tryMigrateQueue(queueName: string, opts: any = {}) {
    if (!(await this.assertQueue(queueName, opts))) {
      const channel = await this.connection.createConfirmChannel();
      await this.migrateQueue(queueName + '.migration.tmp', queueName, opts, channel);
      await this.migrateQueue(queueName, queueName + '.migration.tmp', opts, channel);
      this.logger.info(`Queue ${queueName} migrated successfully.`);
      channel.close();
      return;
    }

    this.logger.info(`Queue ${queueName} already migrated.`);
  }

  async migrateQueue(newQueue: string, fromQueue: string, opts: any = {}, channel: Channel) {
    this.logger.info(`Migrating queue ${fromQueue} to ${newQueue} and opts ${JSON.stringify(opts)}...`);
    await this.assertQueue(newQueue, opts);

    while (true) {
      this.logger.info(`Fetching message from ${fromQueue}...`);
      const message = await channel.get(fromQueue, { noAck: false });
      if (!message) break;
      this.logger.info(`Sending message to ${newQueue} ${message.content}, ${JSON.stringify(message.properties)}...`);
      await new Promise((resolve, reject) =>
        channel.sendToQueue(newQueue, message.content, message.properties, (err: any, ok: any) =>
          err ? reject(err) : resolve(ok)
        )
      );
      channel.ack(message);
    }

    const deleteResponse = await channel.deleteQueue(fromQueue);
    this.logger.info(`Queue ${fromQueue} deleted: ${deleteResponse.messageCount === 0}.`);
    this.logger.info(`Queue ${fromQueue} migrated to ${newQueue}.`);
  }

  async assertQueue(queueName: string, opts: {}): Promise<boolean> {
    const channel = await this.connection.createChannel();
    try {
      channel.on('error', error => {
        this.logger.warn(`Error asserting queue ${queueName}: ${error.message}...`);
      });
      await new Queue(channel, queueName, opts).created;
      channel.close();
      return true;
    } catch (error) {
      return false;
    }
  }
}
