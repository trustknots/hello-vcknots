const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const quietConsole = { log() {}, warn() {}, error() {} };

// Run the actual page scripts with controllable DOM events and delayed network responses.
function page(file, fetch) {
  const elements = new Map();
  const inputs = [];
  const timers = new Map();
  let timerId = 0;
  class Element {
    constructor() {
      this.listeners = {}; this.children = []; this.style = {};
      this.classList = { add() {}, remove() {} };
      this.value = ''; this.disabled = false;
    }
    addEventListener(name, fn) { this.listeners[name] = fn; }
    appendChild(child) { this.children.push(child); return child; }
    querySelectorAll() { return inputs; }
  }
  const document = {
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, new Element());
      return elements.get(id);
    },
    createElement(tag) {
      const element = new Element();
      if (tag === 'input') inputs.push(element);
      return element;
    },
    createTextNode(text) { return { textContent: text }; },
    querySelector() { return inputs.find(input => input.checked); },
    querySelectorAll() { return []; },
  };
  const context = vm.createContext({
    document, fetch, console: quietConsole, alert() {}, window: { addEventListener() {} },
    setInterval(fn) { timers.set(++timerId, fn); return timerId; },
    clearInterval(id) { timers.delete(id); },
  });
  vm.runInContext(read(file).match(/<script>([\s\S]*?)<\/script>/)[1], context);
  return { context, inputs, timers, get: id => document.getElementById(id) };
}

test('wallet prevents duplicate submissions and restores controls after failure', async () => {
  const requests = [];
  const ui = page('wallet/public/index.html', (url, options) =>
    new Promise(resolve => requests.push({ url, options, resolve })));
  vm.runInContext("renderVcSelectList([{id:'A'}, {id:'B'}])", ui.context);
  ui.inputs[0].checked = true;
  ui.inputs[0].listeners.change();
  ui.get('requestUrl').value = 'openid4vp://authorize?state=test';
  ui.get('vcSelectStep').style.display = 'block';
  const confirm = ui.get('btnConfirmPresent');
  const first = confirm.listeners.click();
  assert.equal(confirm.disabled, true);
  assert.equal(ui.get('btnCancelSelect').disabled, true);
  assert.ok(ui.inputs.every(input => input.disabled));
  ui.inputs[1].listeners.change();
  ui.get('btnCancelSelect').listeners.click();
  await confirm.listeners.click();
  assert.equal(confirm.disabled, true);
  assert.equal(ui.get('vcSelectStep').style.display, 'block');
  assert.equal(requests.length, 1);
  assert.equal(JSON.parse(requests[0].options.body).credential_id, 'A');
  requests[0].resolve({ ok: false, json: async () => ({ error: 'Rejected' }) });
  await first;
  assert.equal(confirm.disabled, false);
  assert.equal(ui.get('btnCancelSelect').disabled, false);
  assert.ok(ui.inputs.every(input => !input.disabled));
  const retry = confirm.listeners.click();
  assert.equal(requests.length, 2);
  requests[1].resolve({ ok: true, json: async () => ({ ok: true }) });
  await retry;
  assert.equal(ui.get('vcSelectStep').style.display, 'none');
});

test('verifier ignores an old polling response after starting a new request', async () => {
  const requests = [];
  const ui = page('issuer-verifier/public/verifier.html', url =>
    new Promise(resolve => requests.push({ url, resolve })));
  vm.runInContext("startPolling('A')", ui.context);
  const pollA = [...ui.timers.values()][0];
  const pendingA = pollA();
  await pollA();
  assert.equal(requests.length, 1);
  ui.get('btnRestart').listeners.click();
  vm.runInContext("startPolling('B')", ui.context);
  requests[0].resolve({ ok: true, json: async () => ({ status: 'verified', username: 'A' }) });
  await pendingA;
  assert.equal(ui.get('successArea').style.display, 'none');
  const pendingB = [...ui.timers.values()][0]();
  assert.equal(requests[1].url, '/api/status?state=B');
  requests[1].resolve({ ok: true, json: async () => ({ status: 'verified', username: 'B' }) });
  await pendingB;
  assert.equal(ui.get('verifiedUser').innerText, 'B');
  assert.equal(ui.get('successArea').style.display, 'block');
});

test('routes isolate verification results and reject reused states', async () => {
  const ts = require('../issuer-verifier/node_modules/typescript');
  const { Hono } = require('../issuer-verifier/node_modules/hono');
  const exports = {};
  let failCreation = false;
  // Stub cryptographic flow operations; exercise the actual Hono handlers and state lifecycle.
  const flow = {
    async createAuthzRequest(...args) {
      if (failCreation) throw new Error('Creation failed');
      return { request: { nonce: 'nonce' }, transactionId: args[6].state };
    },
    async verifyPresentations(response) {
      if (response.vp_token.fail) throw new Error('Verification failed');
      const payload = { vc: { credentialSubject: { username: response.state } } };
      const jwt = 'header.' + Buffer.from(JSON.stringify(payload)).toString('base64url') + '.signature';
      return { medal: [{ vp: { verifiableCredential: [jwt] } }] };
    },
  };
  const source = ts.transpileModule(read('issuer-verifier/src/app/routes.ts'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  vm.runInNewContext(source, { exports, Buffer, console: quietConsole, require(name) {
    if (name === 'node:crypto') return require(name);
    if (name === 'hono') return { Hono };
    if (name === '@trustknots/vcknots/verifier') return {
      initializeVerifierFlow: () => flow,
      VerifierClientId: x => x, ClientIdentifier: x => x, VerifierAuthorizationResponse: x => x,
    };
    return {};
  } });
  const router = exports.createVerifierCustomRouter({}, 'http://localhost:8081');
  const request = state => router.request('/request', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ state, credentialId: 'VCKnotsUserMedal' }),
  });
  const callback = (state, fail = false) => router.request('/callback', {
    method: 'POST', body: new URLSearchParams({ state, vp_token: JSON.stringify({ fail }) }),
  });
  const status = async state => (await router.request('/api/status?state=' + state)).json();
  assert.equal((await router.request('/api/status')).status, 400);
  assert.equal((await router.request('/api/status?state=unknown')).status, 404);
  assert.equal((await request('A')).status, 200);
  assert.equal((await callback('A')).status, 200);
  assert.equal((await request('B')).status, 200);
  assert.deepEqual(await status('B'), { status: 'idle', username: '', vc: null });
  assert.equal((await status('A')).username, 'A');
  assert.equal((await callback('B', true)).status, 400);
  assert.equal((await status('B')).status, 'idle');
  assert.equal((await callback('B')).status, 200);
  assert.equal((await status('B')).vc.vc.credentialSubject.username, 'B');
  assert.equal((await status('A')).username, 'A');
  assert.equal((await request('A')).status, 409);
  assert.equal((await callback('A')).status, 400);
  failCreation = true;
  assert.equal((await request('C')).status, 500);
  failCreation = false;
  assert.equal((await request('C')).status, 200);
  assert.deepEqual((await Promise.all([request('D'), request('D')])).map(r => r.status).sort(), [200, 409]);
});
