import Rabbit from './rabbit';
import * as amqp from 'amqplib';
import { decode } from './encode-decode';
import Queue from './queue';
import getLogger from './logger';
import { Migrator } from './migrator';

abstract class BaseQueueHandler {
  public dlqName: string;
  public retries: number;
  public retryDelay: number;
  public logger: ReturnType<typeof getLogger>;
  public queue: Queue;
  public dlq: Queue;
  public logEnabled: boolean;
  public created: Promise<void>;
  public scope: 'SINGLETON' | 'PROTOTYPE';
  public prefetch?: number;
  public options: amqp.Options.AssertQueue & amqp.Options.Consume;
  public migrateQueue: boolean;

  static SCOPES: { singleton: 'SINGLETON'; prototype: 'PROTOTYPE' } = {
    singleton: 'SINGLETON',
    prototype: 'PROTOTYPE'
  };

  constructor(
    public queueName: string,
    public rabbit: Rabbit,
    {
      retries = 3,
      retryDelay = 1000,
      logEnabled = true,
      scope = <'SINGLETON' | 'PROTOTYPE'>BaseQueueHandler.SCOPES.singleton,
      createAndSubscribeToQueue = true,
      prefetch = rabbit.prefetch,
      migrateQueue = false,
      options = {} as amqp.Options.AssertQueue
    } = {}
  ) {
    const logger = getLogger(`rabbit-queue.${queueName}`);

    this.prefetch = prefetch;
    this.retries = retries;
    this.retryDelay = retryDelay;
    this.logger = logger;
    this.logEnabled = logEnabled;
    this.scope = scope;
    this.dlqName = this.getDlq();
    this.options = options;
    this.migrateQueue = migrateQueue;
    if (createAndSubscribeToQueue) {
      this.created = this.createQueues();
    }
  }

  getDlq() {
    return this.queueName + '_dlq';
  }

  getCorrelationId(msg: amqp.Message, _event?: any) {
    return msg.properties.correlationId;
  }

  getQueueOptions() {
    return this.options;
  }

  getDlqOptions() {
    return this.options;
  }

  static prototypeFactory<T extends BaseQueueHandler>(queueName: string, rabbit: Rabbit, options = {}): T {
    const Constructor = <any>this;
    const instance = new Constructor(queueName, rabbit, { ...options, scope: BaseQueueHandler.SCOPES.prototype });
    return instance;
  }

  async createQueues() {
    if (this.migrateQueue) {
      await this.rabbit.connected;
      await new Migrator(this.rabbit.consumeConnection).tryMigrateQueue(this.queueName, this.getQueueOptions());
    }
    this.queue = await this.rabbit
      .createQueue(this.queueName, { ...this.getQueueOptions(), prefetch: this.prefetch }, (msg, ack) => {
        if (this.scope === BaseQueueHandler.SCOPES.singleton) {
          this.tryHandle(0, msg, ack).catch(e => this.logger.error(e));
        } else {
          const instance = new (<any>this.constructor)(this.queueName, this.rabbit, {
            retries: this.retries,
            retryDelay: this.retryDelay,
            logger: this.logger,
            logEnabled: this.logEnabled,
            scope: this.scope,
            createAndSubscribeToQueue: false
          });
          instance.tryHandle(0, msg, ack).catch(e => this.logger.error(e));
        }
      })
      .catch(error => this.logger.error(error));

    if (this.migrateQueue) {
      await new Migrator(this.rabbit.consumeConnection).tryMigrateQueue(this.dlqName, this.getDlqOptions());
    }

    this.dlq = await this.rabbit
      .createQueue(this.dlqName, this.getDlqOptions())
      .catch(error => this.logger.error(error));
  }

  async tryHandle(retries, msg: amqp.Message, ack: (error, reply) => any) {
    try {
      const startTime = this.getTime();
      const event = decode(msg);
      const correlationId = this.getCorrelationId(msg, event);
      this.logger.debug(`[${correlationId}] #${retries + 1} Dequeueing ${this.queueName} `);

      const result = await this.handle({ msg, event, correlationId, startTime });

      this.logger.debug(`[${correlationId}] #${retries + 1} Acknowledging ${this.queueName} `);
      ack(null, result);
      if (this.logEnabled) {
        this.logTime(startTime, correlationId);
      }
    } catch (err) {
      this.handleError(err, msg);
      this.retry(retries, msg, ack).catch(error => this.logger.error(error));
    }
  }

  handleError(err, msg) {
    const logLevel = err?.logLevel || 'error';
    this.logger[logLevel](err);

    if (msg.properties.headers === undefined) {
      msg.properties.headers = {};
    }

    msg.properties.headers.errors = {
      name: err.name && err.name.substr(0, 200),
      message: err.message && err.message.substr(0, 200),
      stack: err.stack && err.stack.substr(0, 200),
      time: new Date().toString()
    };
  }

  getTime() {
    return new Date().getTime();
  }

  logTime(startTime: number, correlationId: string) {
    this.logger.debug(`[${correlationId}] Queue processing took ${new Date().getTime() - startTime} ms`);
  }

  setTimeout(time) {
    return new Promise((resolve, reject) => {
      setTimeout(resolve, time);
    });
  }

  async retry(retries, msg, ack) {
    if (retries < this.retries) {
      this.logger.debug('will retry');
      await this.setTimeout(this.retryDelay);
      await this.tryHandle(retries + 1, msg, ack);
    } else {
      await this.addToDLQ(retries, msg, ack);
    }
  }

  abstract handle(data: { msg: amqp.Message; event: any; correlationId: string; startTime: number });

  afterDlq(data: { msg: amqp.Message; event: any }) {
    this.logger.info(`[${this.getCorrelationId(data.msg)}] Running afterDlq`);
  }

  async addToDLQ(retries, msg: amqp.Message, ack) {
    try {
      const correlationId = this.getCorrelationId(msg);
      const event = decode(msg);
      this.logger.warn(`[${correlationId}] Adding to dlq: ${this.dlqName} after ${retries} retries`);
      await this.rabbit.publish(this.dlqName, event, msg.properties);
      const response = await this.afterDlq({ msg, event });
      ack(msg.properties.headers.errors.message, response);
    } catch (err) {
      this.logger.error(err);
      await this.rabbit.publish(this.dlqName, msg.content.toString(), msg.properties);
      ack(err.message, null);
    }
  }
}

export default BaseQueueHandler;
