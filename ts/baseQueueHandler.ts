import { getNewLogger } from './logger';
import Rabbit from './rabbit';
import * as amqp from 'amqplib';
import Queue from './queue';
import * as assert from 'assert';

abstract class BaseQueueHandler {
  public dlqName: string;
  public retries: number;
  public retryDelay: number;
  public logger;
  public logEnabled: boolean;
  public scope: 'SINGLETON' | 'PROTOTYPE';

  static SCOPES: { singleton: 'SINGLETON', prototype: 'PROTOTYPE' } = {
    singleton: 'SINGLETON',
    prototype: 'PROTOTYPE'
  };

  constructor(public queueName, public rabbit: Rabbit, {
    retries = 3,
    retryDelay = 1000,
    logger = getNewLogger(`[${queueName}]`),
    logEnabled = true,
    scope = (<'SINGLETON' | 'PROTOTYPE'>BaseQueueHandler.SCOPES.singleton),
    createAndSubscribeToQueue = true
  } = {}) {
    assert(typeof logger.debug === 'function', 'logger has no debug method');
    assert(typeof logger.warn === 'function', 'logger has no warn method');
    assert(typeof logger.error === 'function', 'logger has no error method');

    this.retries = retries;
    this.retryDelay = retryDelay;
    this.logger = logger;
    this.logEnabled = logEnabled;
    this.scope = scope;
    this.dlqName = this.getDlq();
    if (createAndSubscribeToQueue) {
      this.createQueues();
    }
  }

  getDlq() {
    return this.queueName + '_dlq';
  }

  getCorrelationId(msg: amqp.Message, event?: any) {
    return msg.properties.correlationId;
  }

  getQueueOptions() {
    return {};
  }

  getDlqOptions() {
    return undefined;
  }

  static prototypeFactory<T extends BaseQueueHandler>(queueName, rabbit: Rabbit, options = {}): T {
    const Constructor = <any>this;
    const instance = new Constructor(queueName, rabbit, { ...options, scope: BaseQueueHandler.SCOPES.prototype });
    return instance;
  }

  createQueues() {
    this.rabbit.createQueue(this.queueName, this.getQueueOptions(),
      (msg, ack) => {
        if (this.scope === BaseQueueHandler.SCOPES.singleton) {
          this.tryHandle(0, msg, ack).catch(e => console.error(e));
        } else {
          const instance = new (<any>this.constructor)(this.queueName, this.rabbit, {
            retries: this.retries,
            retryDelay: this.retryDelay,
            logger: this.logger,
            logEnabled: this.logEnabled,
            scope: this.scope,
            createAndSubscribeToQueue: false
          });
          instance.tryHandle(0, msg, ack).catch(e => console.error(e));
        }
      })
      .catch(error => this.logger.error(error));

    this.rabbit.createQueue(this.dlqName, this.getDlqOptions())
      .catch(error => this.logger.error(error));
  }

  async tryHandle(retries, msg: amqp.Message, ack: (error, reply) => any) {
    try {
      const startTime = this.getTime();
      var body = msg.content.toString();
      const event = JSON.parse(body);
      const correlationId = this.getCorrelationId(msg, event);
      this.logger.debug('[%s] #%s Dequeueing %s ', correlationId, retries + 1, this.queueName);

      const result = await this.handle({ msg, event, correlationId, startTime });

      this.logger.debug('[%s] #%s Acknowledging %s ', correlationId, retries + 1, this.queueName);
      ack(null, result);
      if (this.logEnabled) {
        this.logTime(startTime, correlationId);
      }
    } catch (err) {
      this.handleError(err, msg);
      this.retry(retries, msg, ack)
        .catch((error) => this.logger.error(error));
    }
  }

  handleError(err, msg) {
    this.logger.error(err);
    msg.properties.headers.errors = {
      name: err.name,
      message: err.message,
      stack: err.stack.substr(0, 200),
      time: new Date().toString()
    };
  }

  getTime() {
    return new Date().getTime();
  }

  logTime(startTime: number, correlationId: string) {
    this.logger.debug(`[${correlationId}] Queue processing took ${(new Date().getTime() - startTime)} ms`);
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

  async abstract handle(data: { msg: amqp.Message, event: any, correlationId: string, startTime: number })

  async abstract afterDlq(data: { msg: amqp.Message, event: any })

  async addToDLQ(retries, msg: amqp.Message, ack) {
    try {
      const correlationId = this.getCorrelationId(msg);
      const body = msg.content.toString();
      const event = JSON.parse(body);
      this.logger.warn('[%s] Adding to dlq: %s after %s retries', correlationId, this.dlqName, retries);
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
