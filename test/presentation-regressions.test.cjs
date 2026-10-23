const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const quietConsole = { log() {}, warn() {}, error() {} };

// Run the actual page scripts with controllable DOM events and delayed network responses.
function page(file, fetch, globals = {}) {
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
    ...globals,
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

test('verifier stops polling and allows a new request after expiration', async () => {
  const ui = page('issuer-verifier/public/verifier.html', async () => ({ ok: false, status: 404 }));
  ui.get('btnStart').disabled = true;
  ui.get('verifyArea').style.display = 'block';
  vm.runInContext("startPolling('expired')", ui.context);
  await [...ui.timers.values()][0]();
  assert.equal(ui.timers.size, 0);
  assert.equal(ui.get('verifyArea').style.display, 'none');
  assert.equal(ui.get('startCard').style.display, 'block');
  assert.equal(ui.get('btnStart').disabled, false);
  assert.match(ui.get('verificationNotice').textContent, /有効期限/);
});

test('issuer submits its username with a single Offer creation request', async () => {
  const requests = [];
  const ui = page('issuer-verifier/public/issuer.html', async (url, options) => {
    requests.push({ url, options });
    return { ok: true, text: async () => 'openid-credential-offer://?credential_offer=sample' };
  }, { QRious: function () {} });
  ui.get('username').value = 'Alice';
  await ui.get('btnIssue').listeners.click();
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, '/configurations/VCKnotsUserMedal/offer');
  assert.deepEqual(JSON.parse(requests[0].options.body), { username: 'Alice' });
  assert.equal(ui.get('resultArea').style.display, 'block');
});
