
import * as logger from '../../js/logger';
import * as log4js from 'log4js';
import * as should from 'should';

describe('Test logger', function () {
  it('should inialize logger with name Rabbit-Queue', function () {
    logger.init(null);
    logger.getLogger().should.eql(log4js.getLogger('[Rabbit-Queue]'));
  });

  it('should initialize logger with given one', function () {
    const log = logger.getNewLogger('test');
    logger.init(log);
    logger.getLogger().should.eql(log);
  });

});
