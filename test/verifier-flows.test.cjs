const assert = require('node:assert/strict');
const { test } = require('node:test');
const { generateKeyPairSync, verify, X509Certificate } = require('node:crypto');
const { initializeContext, initializeVerifierFlow } = require('../issuer-verifier/node_modules/@trustknots/vcknots');
const { newHolder, jwt } = require('./helpers/credentials.cjs');

const base = 'http://localhost:8081';
const issuer = 'https://sample-issuer.example';
const issuerKeys = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
let certificatePromise;

async function certificate() {
  if (!certificatePromise) certificatePromise = (async () => {
    require('../issuer-verifier/node_modules/reflect-metadata');
    const x509 = require('../issuer-verifier/node_modules/@peculiar/x509');
    const alg = { name: 'ECDSA', namedCurve: 'P-256', hash: 'SHA-256' };
    const keys = await crypto.subtle.generateKey(alg, true, ['sign', 'verify']);
    const ski = await x509.SubjectKeyIdentifierExtension.create(keys.publicKey);
    const cert = await x509.X509CertificateGenerator.createSelfSigned({
      serialNumber: '01', name: 'CN=localhost', keys, signingAlgorithm: alg,
      notBefore: new Date(Date.now() - 1000), notAfter: new Date(Date.now() + 86400000),
      extensions: [ski, new x509.AuthorityKeyIdentifierExtension(ski.keyId),
        new x509.BasicConstraintsExtension(true, undefined, true),
        new x509.SubjectAlternativeNameExtension([{ type: 'dns', value: 'localhost' }])],
    });
    const pkcs8 = Buffer.from(await crypto.subtle.exportKey('pkcs8', keys.privateKey)).toString('base64');
    return { privateKey: '-----BEGIN PRIVATE KEY-----\n' + pkcs8 + '\n-----END PRIVATE KEY-----\n',
      certificate: cert.toString('pem'), format: 'pem', alg: 'ES256' };
  })();
  return certificatePromise;
}

const post = (app, path, body) => app.request(path, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});

async function setup(t, options = {}) {
  t.mock.method(console, 'log', () => {});
  const { createVerifierRouter } = await import('../issuer-verifier/lib/routes/verify.js');
  const context = initializeContext();
  const flow = initializeVerifierFlow(context);
  await flow.createVerifierMetadata(base, {
    vp_formats_supported: { jwt_vc_json: { alg_values: ['ES256'] } },
  }, await certificate());
  t.mock.method(globalThis, 'fetch', async address => {
    assert.equal(String(address), issuer + '/.well-known/jwt-vc-issuer');
    return Response.json({ issuer, jwks: { keys: [issuerKeys.publicKey.export({ format: 'jwk' })] } });
  });
  const app = createVerifierRouter(context, base, options);
  return { app, flow };
}

async function authorization(app, state, requestObject = false) {
  const response = await post(app, requestObject ? '/request-object' : '/request', {
    state, credentialId: 'VCKnotsUserMedal',
  });
  assert.equal(response.status, 200, await response.clone().text());
  const url = new URL(await response.text());
  if (!requestObject) return Object.fromEntries([...url.searchParams].map(([key, value]) =>
    [key, ['dcql_query', 'client_metadata'].includes(key) ? JSON.parse(value) : value]));
  const jarResponse = await app.request(new URL(url.searchParams.get('request_uri')).pathname);
  assert.equal(jarResponse.status, 200);
  const jar = (await jarResponse.text()).split('.');
  const publicKey = new X509Certificate((await certificate()).certificate).publicKey;
  assert.ok(verify('sha256', Buffer.from(jar[0] + '.' + jar[1]),
    { key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(jar[2], 'base64url')));
  return JSON.parse(Buffer.from(jar[1], 'base64url').toString('utf8'));
}

function presentation(auth, username) {
  const holder = newHolder();
  const now = Math.floor(Date.now() / 1000);
  const vc = jwt({ iss: issuer, sub: holder.did, iat: now, exp: now + 300,
    vc: { '@context': ['https://www.w3.org/2018/credentials/v1'],
      type: ['VerifiableCredential', 'VCKnotsUserMedal'], issuer,
      issuanceDate: new Date().toISOString(), credentialSubject: { id: holder.did, username } },
  }, issuerKeys.privateKey);
  const vp = jwt({ iss: holder.did, aud: auth.client_id, nonce: auth.nonce, iat: now, exp: now + 300,
    vp: { type: ['VerifiablePresentation'], holder: holder.did, verifiableCredential: [vc] },
  }, holder.privateKey, { kid: holder.did });
  return { [auth.dcql_query.credentials[0].id]: [vp] };
}

const callback = (app, state, vp, endpoint = '/callback') => app.request(endpoint, {
  method: 'POST', body: new URLSearchParams({ state, vp_token: JSON.stringify(vp) }),
});
const status = async (app, state) => (await app.request('/api/status?state=' + state)).json();

test('direct and signed Request Object flows share isolated results and reject replay', async t => {
  const { app } = await setup(t);
  const authA = await authorization(app, 'A');
  const authB = await authorization(app, 'B', true);
  assert.equal((await post(app, '/request-object', { state: 'A' })).status, 409);
  assert.equal((await callback(app, 'B', { [authB.dcql_query.credentials[0].id]: ['invalid.jwt'] })).status, 400);
  assert.deepEqual(await status(app, 'B'), { status: 'idle', username: '', vc: null });
  const vp = presentation(authA, 'Alice');
  const responses = await Promise.all([callback(app, 'A', vp), callback(app, 'A', vp)]);
  assert.deepEqual(responses.map(response => response.status).sort(), [200, 400]);
  assert.equal((await status(app, 'A')).username, 'Alice');
  assert.equal((await callback(app, 'B', presentation(authB, 'Bob'), '/callback-kbjwt')).status, 200);
  assert.equal((await status(app, 'B')).username, 'Bob');
  assert.equal((await status(app, 'A')).username, 'Alice');
  assert.equal((await callback(app, 'B', presentation(authB, 'Bob'))).status, 400);
  const unknown = await app.request('/api/status?state=unknown');
  assert.equal(unknown.status, 404);
  assert.equal(unknown.headers.get('Cache-Control'), 'no-store');
  // Failed creation must release its state for a corrected request.
  assert.equal((await post(app, '/request', { state: 'retry', query: { dcql_query: {} } })).status, 400);
  await authorization(app, 'retry');
});

test('signature failures and library exceptions release the session for retry on both callbacks', async t => {
  const { app } = await setup(t);
  for (const endpoint of ['/callback', '/callback-kbjwt']) {
    const state = endpoint.slice(1) + '-retry';
    const auth = await authorization(app, state);
    const vp = presentation(auth, 'Alice');
    const queryId = auth.dcql_query.credentials[0].id;
    const parts = vp[queryId][0].split('.');
    const signature = Buffer.from(parts[2], 'base64url');
    signature[0] ^= 1;
    parts[2] = signature.toString('base64url');
    const invalid = await callback(app, state, { [queryId]: [parts.join('.')] }, endpoint);
    assert.equal(invalid.status, 400);
    assert.equal((await status(app, state)).status, 'idle');

    globalThis.fetch.mock.mockImplementationOnce(async () => {
      throw new Error('Simulated issuer metadata failure');
    });
    const failed = await callback(app, state, vp, endpoint);
    assert.equal(failed.status, 500);
    assert.equal((await status(app, state)).status, 'idle');

    const retry = await callback(app, state, vp, endpoint);
    assert.equal(retry.status, 200, await retry.clone().text());
    assert.equal((await status(app, state)).username, 'Alice');
    assert.equal((await callback(app, state, vp, endpoint)).status, 400);
  }
});

test('expired requests and results are discarded, transactions can be cancelled', async t => {
  const { createVerificationSessionStore } = await import('../issuer-verifier/lib/utils/verification-session-store.js');
  let now = Date.now();
  let flow;
  const sessions = createVerificationSessionStore({
    now: () => now, resultTtlMs: 100, cleanupIntervalMs: 0,
    onDiscard: id => { void flow.deleteTransaction(id); },
  });
  t.after(() => sessions.close());
  const setupResult = await setup(t, { sessions });
  const app = setupResult.app;
  flow = setupResult.flow;
  await authorization(app, 'expiring');
  const pending = sessions.get('expiring');
  const oldTransaction = pending.transactionId;
  now = pending.expiresAt;
  sessions.sweep();
  assert.equal((await app.request('/api/status?state=expiring')).status, 404);
  await assert.rejects(flow.getTransaction(oldTransaction));
  // Use a fresh clock consistent with the newly created library transaction.
  now = Date.now();
  const auth = await authorization(app, 'complete');
  assert.equal((await callback(app, 'complete', presentation(auth, 'Alice'))).status, 200);
  assert.equal((await status(app, 'complete')).status, 'verified');
  now += 100;
  sessions.sweep();
  assert.equal((await app.request('/api/status?state=complete')).status, 404);
  const authC = await authorization(app, 'cancel');
  const transaction = sessions.get('cancel').transactionId;
  assert.equal((await app.request('/presentation-transaction/' + transaction, { method: 'DELETE' })).status, 200);
  assert.equal((await app.request('/api/status?state=cancel')).status, 404);
  assert.equal((await callback(app, 'cancel', presentation(authC, 'Cancelled'))).status, 400);
});

test('a delayed callback cannot overwrite a new session with the same state', async () => {
  const { createVerificationSessionStore } = await import('../issuer-verifier/lib/utils/verification-session-store.js');
  let now = 0;
  const discarded = [];
  const sessions = createVerificationSessionStore({ now: () => now, cleanupIntervalMs: 0,
    onDiscard: id => discarded.push(id) });
  const old = sessions.reserve('same');
  sessions.register('same', old, 'old-transaction', 10);
  const claimed = sessions.claim('same');
  now = 10;
  const replacement = sessions.reserve('same');
  assert.notEqual(replacement, old);
  assert.equal(sessions.register('same', old, 'late-transaction', 100), false);
  assert.equal(sessions.complete('same', claimed, { username: 'Old', vc: null }), false);
  sessions.release('same', claimed);
  sessions.remove('same', old);
  assert.equal(sessions.get('same'), replacement);
  assert.deepEqual(discarded, ['old-transaction']);
});
