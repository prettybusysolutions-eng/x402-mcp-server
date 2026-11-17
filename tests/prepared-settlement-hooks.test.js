'use strict';
// STAGING ONLY. PreparedLedger + settle hooks through the REAL @x402/express 2.28.0 middleware with a
// fake facilitator and real SQLite (issue #41). No wallet, RPC or network; 127.0.0.1 only.
// Does not import server.js and does not change the live payment path.
const CHILD = process.env.X402_PREPARED_CRASH_CHILD;
const test = CHILD ? () => {} : require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const express = require('express');
const { paymentMiddleware, x402ResourceServer, setSettlementOverrides } = require('@x402/express');
const { ExactEvmScheme } = require('@x402/evm/exact/server');
const { PreparedLedger, authorizationId } = require('../lib/prepared-ledger');
const { createPreparedSettlementHooks, registerPreparedSettlementHooks } = require('../lib/prepared-settlement-hooks');

const available = spawnSync('sqlite3', ['--version']).status === 0;
const opt = { skip: !available };
const NET = 'eip155:84532', PAYER = '0x' + 'b'.repeat(40), PAYTO = '0x' + 'd'.repeat(40), TX = '0x' + 'a'.repeat(64);
const NONCE = '0x' + '2'.repeat(64);
const BODY = { analysis: 'computed-before-settlement', n: 7 };

function tmpdb() { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'x402-hooks-')); return { dir, db: path.join(dir, 'prepared.sqlite3') }; }

async function fixture({ ledger, settleImpl, handler, extraHooks = {}, beforeOurs = {} }) {
  const events = [];
  const facilitator = {
    calls: 0, atSettle: [],
    async getSupported() { return { kinds: [{ x402Version: 2, scheme: 'exact', network: NET }], extensions: [], signers: {} }; },
    async verify() { events.push('verify'); return { isValid: true, payer: PAYER }; },
    async settle(payload, requirements) {
      this.calls++; events.push('settle');
      // Snapshot durable state at the moment money would move.
      const id = authorizationId({ network: requirements.network, asset: requirements.asset, payer: payload.payload.authorization.from, nonce: payload.payload.authorization.nonce });
      this.atSettle.push(ledger.get(id));
      return settleImpl ? settleImpl() : { success: true, transaction: TX, network: NET, payer: PAYER };
    },
  };
  const resource = new x402ResourceServer(facilitator).register(NET, new ExactEvmScheme());
  for (const [name, fn] of Object.entries(beforeOurs)) resource[name](fn);
  const logged = [];
  registerPreparedSettlementHooks(resource, { ledger, log: (what, e) => logged.push(what + ': ' + (e?.message || e)) });
  for (const [name, fn] of Object.entries(extraHooks)) resource[name](fn);
  await resource.initialize();
  const app = express(); app.use(express.json());
  app.use(paymentMiddleware({ 'POST /contract-analysis': { accepts: { scheme: 'exact', price: '$0.001', network: NET, payTo: PAYTO }, description: 'prepared ledger probe' } },
    resource, undefined, undefined, true));
  app.post('/contract-analysis', (req, res) => { events.push('handler'); if (handler) return handler(req, res); res.json(BODY); });
  const listener = await new Promise(r => { const l = app.listen(0, '127.0.0.1', () => r(l)); });
  const url = 'http://127.0.0.1:' + listener.address().port + '/contract-analysis';
  return { events, facilitator, logged, url, close: () => new Promise(r => listener.close(r)) };
}

async function pay(url, { nonce = NONCE, body = '{"address":"0xabc"}', query = '' } = {}) {
  const first = await fetch(url + query, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(first.status, 402);
  const required = JSON.parse(Buffer.from(first.headers.get('payment-required'), 'base64').toString());
  const accepted = required.accepts[0];
  const payload = { x402Version: 2, resource: required.resource, accepted, payload: { signature: '0x' + '1'.repeat(130),
    authorization: { from: PAYER, to: accepted.payTo, value: accepted.amount, validAfter: '0', validBefore: String(Math.floor(Date.now() / 1000) + 600), nonce } } };
  const r = await fetch(url + query, { method: 'POST', headers: { 'content-type': 'application/json', 'PAYMENT-SIGNATURE': Buffer.from(JSON.stringify(payload)).toString('base64') }, body });
  return { status: r.status, text: await r.text(), accepted, id: authorizationId({ network: NET, asset: accepted.asset, payer: PAYER, nonce }) };
}

function withDb(fn) {
  return async () => { const { dir, db } = tmpdb(); try { await fn(new PreparedLedger(db), db, dir); } finally { fs.rmSync(dir, { recursive: true, force: true }); } };
}

test('PREPARED record with response is durable BEFORE facilitator settle; then FACILITATOR_SETTLED', opt, withDb(async ledger => {
  const f = await fixture({ ledger });
  try {
    const r = await pay(f.url);
    assert.equal(r.status, 200);
    assert.deepEqual(JSON.parse(r.text), BODY);
    assert.equal(f.facilitator.calls, 1);
    assert.equal(f.facilitator.atSettle[0].state, 'PREPARED', 'record committed before money moves');
    assert.equal(f.facilitator.atSettle[0].payer, PAYER);
    assert.equal(f.facilitator.atSettle[0].amountAtomic, r.accepted.amount);
    assert.equal(f.facilitator.atSettle[0].endpoint, '/contract-analysis');
    const row = ledger.get(r.id);
    assert.equal(row.state, 'FACILITATOR_SETTLED');
    assert.equal(row.settlementTx, TX);
    assert.deepEqual(JSON.parse(ledger.getResponse(r.id)), BODY);
    assert.deepEqual(f.logged, []);
  } finally { await f.close(); }
}));

test('real SQLite write failure in onBeforeSettle aborts: no charge, no output, 402', opt, async () => {
  const { dir, db } = tmpdb();
  const ledger = new PreparedLedger(db);
  fs.rmSync(dir, { recursive: true, force: true }); // database directory vanishes after startup
  const f = await fixture({ ledger: { ...ledger, prepare: ledger.prepare.bind(ledger), get: () => null,
    markFacilitatorSettled: ledger.markFacilitatorSettled.bind(ledger), markUnknown: ledger.markUnknown.bind(ledger) } });
  try {
    const r = await pay(f.url);
    assert.equal(r.status, 402);
    assert.equal(f.facilitator.calls, 0, 'facilitator settle never called');
    assert.ok(!r.text.includes('computed-before-settlement'));
    assert.equal(f.logged.length, 1);
    assert.match(f.logged[0], /^prepare_failed: /);
  } finally { await f.close(); }
});

test('replayed authorization (same request) is aborted; one charge; first response kept', opt, withDb(async ledger => {
  const f = await fixture({ ledger });
  try {
    const a = await pay(f.url);
    const b = await pay(f.url);
    assert.equal(a.status, 200);
    assert.equal(b.status, 402);
    assert.equal(f.facilitator.calls, 1);
    assert.deepEqual(JSON.parse(ledger.getResponse(a.id)), BODY);
  } finally { await f.close(); }
}));

test('same authorization for a different request is a conflict: aborted, record unchanged', opt, withDb(async ledger => {
  const f = await fixture({ ledger });
  try {
    const a = await pay(f.url, { body: '{"address":"0xabc"}' });
    const before = ledger.get(a.id);
    const b = await pay(f.url, { body: '{"address":"0xdef"}' });
    assert.equal(b.status, 402);
    assert.equal(f.facilitator.calls, 1);
    assert.deepEqual(ledger.get(a.id), before);
  } finally { await f.close(); }
}));

test('request digest binds query parameters (Express 5 null-prototype query)', opt, withDb(async ledger => {
  const f = await fixture({ ledger });
  try {
    const a = await pay(f.url, { query: '?depth=1' });
    assert.equal(a.status, 200);
    const b = await pay(f.url, { query: '?depth=2', nonce: '0x' + '4'.repeat(64) });
    assert.equal(b.status, 200);
    assert.notEqual(ledger.get(a.id).requestDigest, ledger.get(b.id).requestDigest);
  } finally { await f.close(); }
}));

test('ambiguous facilitator error: buyer gets 402, record UNKNOWN with response retained', opt, withDb(async ledger => {
  const f = await fixture({ ledger, settleImpl: () => { throw new Error('socket hang up'); } });
  try {
    const r = await pay(f.url);
    assert.equal(r.status, 402);
    const row = ledger.get(r.id);
    assert.equal(row.state, 'UNKNOWN');
    assert.match(row.reason, /socket hang up/);
    assert.deepEqual(JSON.parse(ledger.getResponse(r.id)), BODY);
  } finally { await f.close(); }
}));

test('settlement_pending after retry: UNKNOWN, never unpaid', opt, withDb(async ledger => {
  const f = await fixture({ ledger, settleImpl: () => ({ success: false, errorReason: 'settlement_pending', transaction: TX, network: NET, payer: PAYER }) });
  try {
    const r = await pay(f.url);
    assert.equal(r.status, 402);
    assert.equal(f.facilitator.calls, 2);
    assert.equal(ledger.get(r.id).state, 'UNKNOWN');
  } finally { await f.close(); }
}));

test('facilitator success with a foreign payer is recorded as EXCEPTION', opt, withDb(async ledger => {
  const f = await fixture({ ledger, settleImpl: () => ({ success: true, transaction: TX, network: NET, payer: '0x' + 'c'.repeat(40) }) });
  try {
    const r = await pay(f.url);
    assert.equal(ledger.get(r.id).state, 'EXCEPTION');
    assert.match(ledger.get(r.id).reason, /payer mismatch/);
  } finally { await f.close(); }
}));

test('handler settlement override is refused before any write or charge', opt, withDb(async ledger => {
  const f = await fixture({ ledger, handler: (_req, res) => { setSettlementOverrides(res, { amount: '1' }); res.json(BODY); } });
  try {
    const r = await pay(f.url);
    assert.equal(r.status, 402);
    assert.equal(f.facilitator.calls, 0);
    assert.equal(ledger.get(r.id), null);
  } finally { await f.close(); }
}));

test('handler 5xx: no prepared record, no charge', opt, withDb(async ledger => {
  const f = await fixture({ ledger, handler: (_req, res) => res.status(500).json({ error: 'boom' }) });
  try {
    const r = await pay(f.url);
    assert.equal(r.status, 500);
    assert.equal(f.facilitator.calls, 0);
    assert.equal(ledger.get(r.id), null);
  } finally { await f.close(); }
}));

test('hook refuses unsupported phase, scheme, Permit2, missing body, amount or payee mismatch', async () => {
  let prepared = 0;
  const { onBeforeSettle } = createPreparedSettlementHooks({ ledger: { prepare: () => { prepared++; return { outcome: 'inserted' }; } } });
  const base = () => ({ phase: 'after-handler',
    requirements: { scheme: 'exact', network: NET, asset: '0x' + 'e'.repeat(40), payTo: PAYTO, amount: '1000', extra: {} },
    paymentPayload: { payload: { authorization: { from: PAYER, to: PAYTO, value: '1000', validBefore: '9999999999', nonce: NONCE } } },
    transportContext: { responseBody: Buffer.from('{}'), responseHeaders: {}, request: { method: 'POST', adapter: { getMethod: () => 'POST', getPath: () => '/contract-analysis', getQueryParams: () => ({}), getBody: () => ({}) } } } });
  const cases = [
    ['unsupported_phase', c => { c.phase = 'before-handler'; }],
    ['unsupported_scheme', c => { c.requirements.scheme = 'upto'; }],
    ['unsupported_payment_method', c => { c.paymentPayload.payload = { permit2Authorization: {} }; }],
    ['unsupported_payment_method', c => { c.requirements.extra.assetTransferMethod = 'permit2'; }],
    ['missing_response_body', c => { c.transportContext.responseBody = Buffer.alloc(0); }],
    ['missing_response_body', c => { delete c.transportContext.responseBody; }],
    ['settlement_override_unsupported', c => { c.transportContext.responseHeaders['Settlement-Overrides'] = '{}'; }],
    ['amount_mismatch', c => { c.requirements.amount = '999'; }],
    ['payee_mismatch', c => { c.paymentPayload.payload.authorization.to = '0x' + 'c'.repeat(40); }],
    ['missing_request_context', c => { delete c.transportContext.request; }],
    ['prepare_failed', c => { c.transportContext.request.adapter.getBody = () => { throw new Error('body unavailable'); }; }],
  ];
  for (const [reason, mutate] of cases) {
    const c = base(); mutate(c);
    const r = await onBeforeSettle(c);
    assert.equal(r?.abort, true, reason);
    assert.equal(r.reason, reason);
    assert.ok(!('skip' in r));
  }
  assert.equal(prepared, 0, 'no write on any refused context');
  assert.equal(await onBeforeSettle(base()), undefined, 'valid context proceeds');
  assert.equal(prepared, 1);
});

test('crash after facilitator success, before our after-settle write and delivery: PREPARED survives in SQLite and reconciles', { ...opt, timeout: 30000 }, async () => {
  const { dir, db } = tmpdb();
  const child = spawn(process.execPath, [__filename], { env: { ...process.env, X402_PREPARED_CRASH_CHILD: db }, stdio: ['ignore', 'pipe', 'inherit'] });
  try {
    const url = await new Promise((resolve, reject) => {
      let b = ''; child.stdout.on('data', d => { b += d; const m = b.match(/LISTENING (\S+)/); if (m) resolve(m[1]); });
      child.on('exit', c => reject(new Error('child exited early ' + c)));
    });
    let outcome, id;
    try { const r = await pay(url); outcome = 'status ' + r.status; } catch { outcome = 'transport error'; }
    assert.equal(outcome, 'transport error', 'buyer receives nothing after the charge');
    const signal = await new Promise(r => child.signalCode ? r(child.signalCode) : child.on('exit', (_c, s) => r(s)));
    assert.equal(signal, 'SIGKILL');
    const asset = JSON.parse(fs.readFileSync(db + '.asset', 'utf8'));
    id = authorizationId({ network: NET, asset, payer: PAYER, nonce: NONCE });
    const after = new PreparedLedger(db, { verifier: row => ({ source: 'onchain-receipt', finalized: true, blockNumber: 9, paid: true,
      authorizationUsed: true, transferMatched: true, transaction: TX, network: row.network, asset: row.asset, payTo: row.payTo,
      payer: row.payer, amountAtomic: row.amountAtomic, nonce: row.nonce }) });
    assert.equal(after.get(id).state, 'PREPARED', 'after-settle write never happened');
    assert.deepEqual(JSON.parse(after.getResponse(id)), BODY, 'response recoverable without recompute');
    assert.equal(after.reconcile(id), true);
    assert.equal(after.get(id).state, 'RECONCILED_PAID');
  } finally { child.kill('SIGKILL'); fs.rmSync(dir, { recursive: true, force: true }); }
});

// Crash child: our hooks + real SQLite; a hook registered BEFORE ours SIGKILLs the process inside
// onAfterSettle, i.e. after facilitator success and before our markFacilitatorSettled and delivery.
if (CHILD && require.main === module) {
  const ledger = new PreparedLedger(CHILD);
  fixture({ ledger, beforeOurs: { onAfterSettle: async ctx => {
    fs.writeFileSync(CHILD + '.asset', JSON.stringify(ctx.requirements.asset));
    process.kill(process.pid, 'SIGKILL');
  } } }).then(f => process.stdout.write('LISTENING ' + f.url + '\n'));
}
