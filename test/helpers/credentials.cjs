const { generateKeyPairSync, sign } = require('node:crypto');

function newHolder() {
  const keys = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = keys.publicKey.export({ format: 'jwk' });
  const bytes = Buffer.concat([Buffer.from([0x80, 0x24, 2 + (Buffer.from(jwk.y, 'base64url')[31] & 1)]),
    Buffer.from(jwk.x, 'base64url')]);
  const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let n = BigInt('0x' + bytes.toString('hex')), encoded = '';
  while (n > 0n) { encoded = alphabet[Number(n % 58n)] + encoded; n /= 58n; }
  return { ...keys, did: 'did:key:z' + encoded };
}

function jwt(payload, privateKey, header = {}) {
  const content = Buffer.from(JSON.stringify({ alg: 'ES256', typ: 'JWT', ...header })).toString('base64url') + '.' +
    Buffer.from(JSON.stringify(payload)).toString('base64url');
  return content + '.' + sign('sha256', Buffer.from(content),
    { key: privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url');
}

const decode = token => JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
module.exports = { newHolder, jwt, decode };
