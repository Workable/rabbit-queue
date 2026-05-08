import { encode, decode } from '../ts/encode-decode';

describe('encode-decode', function() {
  describe('encode', function() {
    it('supports json', function() {
      encode({ foo: 'bar' }).should.eql(encode({ foo: 'bar' }, 'application/json'));
      encode({ foo: 'bar' }).should.eql(Buffer.from('{"foo":"bar"}'));
    });

    it('supports binary', function() {
      encode(Buffer.from('foo'), 'application/binary').should.eql(Buffer.from('foo'));
    });

    it('supports text', function() {
      encode('foo', 'application/text').should.eql(Buffer.from('foo'));
    });

    it('returns Buffer unchanged without re-encoding as JSON', function() {
      const buf = Buffer.from('{"foo":"bar"}');
      const result = encode(buf);
      result.should.equal(buf);
      result.toString().should.equal('{"foo":"bar"}');
    });
  });

  describe('decode', function() {
    it('supports json', function() {
      decode({ content: Buffer.from('{"foo":"bar"}') } as any).should.eql({ foo: 'bar' });
    });

    it('supports binary', function() {
      decode({ content: Buffer.from('foo'), properties: { contentType: 'application/binary' } } as any).should.eql(
        'foo'
      );
    });

    it('supports text', function() {
      decode({ content: Buffer.from('foo'), properties: { contentType: 'application/text' } } as any).should.eql('foo');
    });
  });
});
