import * as sinon from 'sinon';
import * as amqp from 'amqplib';
import { Migrator } from '../ts/migrator';
import Queue from '../ts/queue';
import Rabbit from '../ts/rabbit';
import 'should';

const sandbox = sinon.createSandbox();

describe('Migrator Tests', function () {
  let connection: amqp.ChannelModel;
  let migrator: Migrator;

  before(async function () {
    this.url = process.env.RABBIT_URL || 'amqp://localhost';
    this.name = 'test.migrator';
    this.rabbit = new Rabbit(this.url, {});
    this.rabbit.on('log', () => {});
    await this.rabbit.connected;
    migrator = new Migrator(this.rabbit.consumeConnection);
  });

  beforeEach(function () {
    this.assertQueueStub = sandbox.spy(migrator, 'assertQueue');
    this.migrateQueueStub = sandbox.spy(migrator, 'migrateQueue');
    this.assertCreateConfirmChannelStub = sandbox.spy(this.rabbit.consumeConnection, 'createConfirmChannel');
  });

  after(async function () {
    this.rabbit.close();
  });

  afterEach(async function () {
    await this.rabbit.destroyQueue(this.name);
    sandbox.restore();
  });

  it('should not migrate queue already migrated', async function () {
    await migrator.tryMigrateQueue(this.name);

    this.assertQueueStub.callCount.should.equal(1);
    this.migrateQueueStub.called.should.be.false();
    this.assertCreateConfirmChannelStub.called.should.be.false();
  });

  it('should migrate queue', async function () {
    const queue = new Queue(this.rabbit.consumeChannel, this.name, { noAck: true });
    await queue.created;

    await migrator.tryMigrateQueue(this.name, { noAck: true, priority: 1 });

    this.assertQueueStub.callCount.should.equal(3);
    this.migrateQueueStub.calledTwice.should.be.true();
    this.assertCreateConfirmChannelStub.calledOnce.should.be.true();
  });

  it('should migrate queue and messages', async function () {
    const queue = new Queue(this.rabbit.consumeChannel, this.name, { noAck: true });
    await queue.created;
    await this.rabbit.publish(this.name, { test: 'data' }, { correlationId: '1' });

    await migrator.tryMigrateQueue(this.name, { exclusive: true, noAck: true, priority: 1 });
    const message = await this.rabbit.consumeChannel.get(this.name, { noAck: true });
    message.content.toString().should.equal(JSON.stringify({ test: 'data' }));
  });
});
