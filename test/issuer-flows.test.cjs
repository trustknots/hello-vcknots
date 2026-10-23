const assert = require('node:assert/strict');
const { test } = require('node:test');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const { createPublicKey, randomUUID, verify } = require('node:crypto');
const { Hono } = require('../issuer-verifier/node_modules/hono');
const { initializeContext, initializeIssuerFlow, initializeAuthzFlow } =
  require('../issuer-verifier/node_modules/@trustknots/vcknots');
const { newHolder, jwt, decode } = require('./helpers/credentials.cjs');
const base = 'http://localhost:8080';
const grantType = 'urn:ietf:params:oauth:grant-type:pre-authorized_code';

const post = (app, path, body, headers = {}) => app.request(path, {
  method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body),
});
const redeem = (app, code, extra = {}, headers = {}) => app.request('/token', {
  method: 'POST', headers, body: new URLSearchParams({ grant_type: grantType, 'pre-authorized_code': code, ...extra }),
});

async function setup(t, options = {}) {
  t.mock.method(console, 'log', () => {});
  const { createIssuerCustomRouter } = await import('../issuer-verifier/lib/app/routes.js');
  const { createIssueRouter } = await import('../issuer-verifier/lib/routes/issue.js');
  const { createAuthzRouter } = await import('../issuer-verifier/lib/routes/authz.js');
  const { createIssuanceSessionStore } = await import('../issuer-verifier/lib/utils/issuance-session-store.js');
  const context = initializeContext({ debug: true });
  const issuerFlow = initializeIssuerFlow(context), authzFlow = initializeAuthzFlow(context);
  const metadata = name => JSON.parse(readFileSync(resolve(__dirname, '../issuer-verifier/config/metadata', name), 'utf8'));
  await issuerFlow.createIssuerMetadata(metadata('issuer_metadata.json'));
  await authzFlow.createAuthzServerMetadata(metadata('authorization_metadata.json'));
  const sessions = createIssuanceSessionStore({ cleanupIntervalMs: 0, ...options });
  t.after(() => sessions.close());
  const app = new Hono();
  app.route('/', createIssuerCustomRouter(context, base, sessions));
  app.route('/', createIssueRouter(context, base));
  app.route('/', createAuthzRouter(context, base, { issuanceSessions: sessions }));
  return { app, sessions, issuerFlow, authzFlow };
}

async function offer(app, username) {
  const response = await post(app, '/configurations/VCKnotsUserMedal/offer', { username });
  assert.equal(response.status, 200, await response.clone().text());
  const offer = JSON.parse(new URL(await response.text()).searchParams.get('credential_offer'));
  return offer.grants[grantType]['pre-authorized_code'];
}

async function receive(app, token) {
  const holder = newHolder();
  const nonceResponse = await app.request('/nonce', { method: 'POST' });
  const nonce = (await nonceResponse.json()).c_nonce;
  const proof = jwt({ aud: base, iat: Math.floor(Date.now() / 1000), nonce }, holder.privateKey,
    { typ: 'openid4vci-proof+jwt', kid: holder.did });
  const response = await post(app, '/credentials', {
    credential_configuration_id: 'VCKnotsUserMedal', proofs: { jwt: [proof] },
  }, { Authorization: 'Bearer ' + token.access_token });
  assert.equal(response.status, 200, await response.clone().text());
  return (await response.json()).credentials[0].credential;
}

test('offer identity survives reversed redemption and concurrent credential issuance', async t => {
  const { app, issuerFlow, sessions } = await setup(t);
  const codeA = await offer(app, 'Alice'), codeB = await offer(app, ' Bob ');
  const tokenB = await (await redeem(app, codeB)).json();
  const tokenA = await (await redeem(app, codeA)).json();
  await offer(app, 'Carol');
  const [vcA, vcB] = await Promise.all([receive(app, tokenA), receive(app, tokenB)]);
  assert.equal(decode(vcA).vc.credentialSubject.username, 'Alice');
  assert.equal(decode(vcB).vc.credentialSubject.username, 'Bob');
  const metadata = await issuerFlow.findJwtVcIssuerMetadata(base);
  const publicKey = createPublicKey({ key: metadata.jwks.keys[0], format: 'jwk' });
  for (const token of [vcA, vcB]) {
    const parts = token.split('.');
    assert.ok(verify('sha256', Buffer.from(parts[0] + '.' + parts[1]),
      { key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(parts[2], 'base64url')));
  }
  assert.equal(sessions.getOffer(codeA), undefined);
  assert.equal((await redeem(app, codeA)).status, 400);
  assert.equal((await post(app, '/api/setup', { username: 'Overwrite' })).status, 404);
});

test('invalid input and unbound tokens cannot issue credentials; failed redemption preserves identity', async t => {
  const { app, sessions, issuerFlow, authzFlow } = await setup(t);
  for (const body of [{}, { username: 123 }, { username: '  ' }, []]) {
    assert.equal((await post(app, '/configurations/VCKnotsUserMedal/offer', body)).status, 400);
  }
  assert.equal((await redeem(app, 'unknown')).status, 400);
  const code = await offer(app, 'Alice');
  assert.equal((await redeem(app, code, { tx_code: 'unexpected' })).status, 400);
  assert.equal(sessions.getOffer(code).username, 'Alice');
  const token = await (await redeem(app, code)).json();
  assert.equal(decode(await receive(app, token)).vc.credentialSubject.username, 'Alice');
  assert.equal((await post(app, '/credentials', { credential_configuration_id: 'VCKnotsUserMedal' },
    { Authorization: 'Bearer invalid.token.signature' })).status, 401);

  // A cryptographically valid token issued outside the application's Offer lifecycle has no claims binding.
  const external = await issuerFlow.offerCredential(base, ['VCKnotsUserMedal'], { usePreAuth: true });
  const unbound = await authzFlow.createAccessToken(base, {
    grant_type: grantType, 'pre-authorized_code': external.offer.grants[grantType]['pre-authorized_code'],
  });
  const response = await post(app, '/credentials', { credential_configuration_id: 'VCKnotsUserMedal' },
    { Authorization: 'Bearer ' + unbound.access_token });
  assert.equal(response.status, 400);
  assert.match((await response.json()).error_description, /session not found/);
});

test('expired Offer and token bindings are rejected and swept', async t => {
  let now = Date.now();
  const { app, sessions } = await setup(t, { now: () => now });
  const expiredCode = await offer(app, 'Expired');
  now += 600000;
  sessions.sweep();
  assert.equal(sessions.getOffer(expiredCode), undefined);
  assert.equal((await redeem(app, expiredCode)).status, 400);
  now = Date.now();
  const code = await offer(app, 'Alice');
  const token = await (await redeem(app, code)).json();
  assert.equal(sessions.getForToken(token.access_token).username, 'Alice');
  now += token.expires_in * 1000;
  sessions.sweep();
  assert.equal(sessions.getForToken(token.access_token), undefined);
  const response = await post(app, '/credentials', { credential_configuration_id: 'VCKnotsUserMedal' },
    { Authorization: 'Bearer ' + token.access_token });
  assert.equal(response.status, 400);
  assert.match((await response.json()).error_description, /session not found/);
});

test('DPoP nonce challenge preserves the Offer binding until successful token issuance', async t => {
  const { app, authzFlow, sessions } = await setup(t);
  await authzFlow.createAuthzOAuthPolicy(base, {
    anonymous_client: { senderConstrainedAccessToken: { method: 'dpop', dpop: { mode: 'optional' } } },
  });
  const code = await offer(app, 'Alice');
  const holder = newHolder();
  const proof = nonce => jwt({ jti: randomUUID(), iat: Math.floor(Date.now() / 1000),
    htm: 'POST', htu: base + '/token', ...(nonce ? { nonce } : {}),
  }, holder.privateKey, { typ: 'dpop+jwt', jwk: holder.publicKey.export({ format: 'jwk' }) });
  const challenge = await redeem(app, code, {}, { DPoP: proof() });
  assert.equal(challenge.status, 400);
  assert.equal((await challenge.json()).error, 'use_dpop_nonce');
  assert.equal(sessions.getOffer(code).username, 'Alice');
  const response = await redeem(app, code, {}, { DPoP: proof(challenge.headers.get('DPoP-Nonce')) });
  assert.equal(response.status, 200, await response.clone().text());
  const token = await response.json();
  assert.equal(token.token_type, 'DPoP');
  assert.equal(sessions.getForToken(token.access_token).username, 'Alice');
  assert.equal(sessions.getOffer(code), undefined);
});
