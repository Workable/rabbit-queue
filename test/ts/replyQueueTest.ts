import 'should';
import * as assert from 'assert';
import * as sinon from 'sinon';
import * as ReplyQueue from '../../js/replyQueue';
import Rabbit from '../../js/rabbit';
const sandbox = sinon.sandbox.create();

describe('Test ReplyQueue', function () {
  before(function () {
    this.url = process.env.RABBIT_URL || 'amqp://localhost';
  });

  afterEach(function () {
    sandbox.restore();
  });

  it('should createReplyQueue', async function () {
    const rabbit = new Rabbit(this.url);
    await rabbit.connected;
    const stub = sandbox.stub(rabbit.channel, 'consume');
    await ReplyQueue.createReplyQueue(rabbit.channel);
    stub.calledOnce.should.be.true();
    stub.args[0][0].should.eql(rabbit.channel.replyName);
    stub.args[0][2].should.eql({ noAck: true });
  });

  it('should call Handler on message', async function () {
    const rabbit = new Rabbit(this.url);
    await rabbit.connected;
    const stub = sandbox.stub(rabbit.channel, 'consume');
    await ReplyQueue.createReplyQueue(rabbit.channel);
    const handler = (err, body) => {
      body.should.equal('test_body');
    }
    ReplyQueue.addHandler(1, handler);
    stub.callArgWith(1, { properties: { correlationId: 1 }, content: '"test_body"' });
  });
});
