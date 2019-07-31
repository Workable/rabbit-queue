export function encode(message: Buffer | string | Object = '', contentType = 'application/json') {
  if (contentType === 'application/json') {
    return Buffer.from(JSON.stringify(message));
  }
  return Buffer.from(message.toString());
}

export function decode(msg) {
  const { contentType = 'application/json' } = msg.properties || {};
  if (contentType === 'application/json') {
    return JSON.parse(msg.content.toString());
  }
  return msg.content.toString();
}
