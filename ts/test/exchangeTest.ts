import 'should';
import * as assert from 'assert';
import * as sinon from 'sinon';
import Exchange from '../exchange';
import Rabbit from '../rabbit';
const sandbox = sinon.sandbox.create();

describe('Test Exchange', function () {
  before(function () {
    this.url = process.env.RABBIT_URL || 'amqp://localhost';
  });

  afterEach(function () {
    sandbox.restore();
  });

  it('should publish to exchange', async function () {
    const rabbit = new Rabbit(this.url);
    await rabbit.connected;
    const stub = sandbox.stub(rabbit.channel, 'publish');
    stub.callsArgWith(4, null, 'ok');
    const content = { content: true };
    const headers = { headers: { test: 1 }, persistent: false };
    await Exchange.publish(rabbit.channel, 'exchange', 'routingKey', content, headers);
    stub.calledOnce.should.be.true();
    stub.args[0].slice(0, 4).should.eql(['exchange', 'routingKey', new Buffer(JSON.stringify(content)), headers]);
  });


});
