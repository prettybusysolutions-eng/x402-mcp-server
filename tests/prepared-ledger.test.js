'use strict';
// STAGING ONLY. PreparedLedger against real SQLite (issue #41). No wallet, RPC or network.
const CHILD = process.env.X402_PREPARED_RACE_CHILD;
const test = CHILD ? () => {} : require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync, spawnSync, spawn } = require('node:child_process');
const { PreparedLedger, authorizationId } = require('../lib/prepared-ledger');

const available = spawnSync('sqlite3', ['--version']).status === 0;
const NET = 'eip155:84532';
const ASSET = '0x036cbd53842c5426634e7929541ec2318f3dcf7e';
const PAYTO = '0x' + 'd'.repeat(40);
const PAYER = '0x' + 'b'.repeat(40);
const NONCE = '0x' + '2'.repeat(64);
const TX = '0x' + 'a'.repeat(64);
const BODY = Buffer.from(JSON.stringify({ analysis: 'prepared', n: 1 }));
const T0 = 1_900_000_000;

function input(over = {}) {
  return { network: NET, asset: ASSET, payTo: PAYTO, payer: PAYER, amountAtomic: '1000', nonce: NONCE,
    validBefore: T0 + 600, endpoint: '/contract-analysis', requestDigest: 'e'.repeat(64), ...over };
}
function tmpdb() { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'x402-prepared-')); return { dir, db: path.join(dir, 'prepared.sqlite3') }; }
function withLedger(opts, fn) {
  const { dir, db } = tmpdb();
  try { return fn(new PreparedLedger(db, opts), db, dir); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
function evidence(row, over = {}) {
  return { source: 'onchain-receipt', finalized: true, blockNumber: 123, paid: true, authorizationUsed: true, transferMatched: true,
    transaction: TX, network: row.network, asset: row.asset, payTo: row.payTo, payer: row.payer, amountAtomic: row.amountAtomic, nonce: row.nonce, ...over };
}
const opt = { skip: !available };

test('authorization id: deterministic, case-insensitive, domain-separated, strict', () => {
  const base = { network: NET, asset: ASSET, payer: PAYER, nonce: NONCE };
  const id = authorizationId(base);
  assert.match(id, /^[0-9a-f]{64}$/);
  assert.equal(authorizationId({ ...base, asset: ASSET.toUpperCase().replace('0X', '0x'), payer: PAYER.toUpperCase().replace('0X', '0x') }), id);
  for (const k of ['network', 'asset', 'payer', 'nonce']) {
    const alt = { network: 'eip155:8453', asset: '0x' + 'c'.repeat(40), payer: '0x' + 'f'.repeat(40), nonce: '0x' + '3'.repeat(64) }[k];
    assert.notEqual(authorizationId({ ...base, [k]: alt }), id, k);
  }
  assert.notEqual(id, crypto.createHash('sha256').update([NET, ASSET, PAYER, NONCE].join('\n')).digest('hex'), 'domain tag applied');
  for (const bad of [{ network: 'base' }, { asset: '0x12' }, { payer: 'nope' }, { nonce: '0x' + 'g'.repeat(64) }]) {
    assert.throws(() => authorizationId({ ...base, ...bad }));
  }
});

test('prepare inserts PREPARED and response bytes round-trip with integrity check', opt, () => withLedger({}, l => {
  const r = l.prepare(input(), BODY);
  assert.equal(r.outcome, 'inserted');
  assert.equal(r.record.state, 'PREPARED');
  assert.equal(r.record.payer, PAYER);
  assert.equal(r.record.nonce, NONCE);
  assert.equal(r.record.amountAtomic, '1000');
  assert.equal(r.record.responseSha256, crypto.createHash('sha256').update(BODY).digest('hex'));
  assert.deepEqual(l.getResponse(r.record.authorizationId), BODY);
}));

test('large (>128 KiB) binary response is stored via stdin, not argv', opt, () => withLedger({}, l => {
  const big = crypto.randomBytes(300 * 1024);
  const r = l.prepare(input(), big);
  assert.equal(r.outcome, 'inserted');
  assert.ok(l.getResponse(r.record.authorizationId).equals(big));
}));

test('input validation rejects malformed bindings and bodies', opt, () => withLedger({ maxResponseBytes: 64 }, l => {
  for (const bad of [{ amountAtomic: '01' }, { amountAtomic: '-1' }, { amountAtomic: '1.5' }, { amountAtomic: '' },
    { nonce: '0x1234' }, { payTo: 'x' }, { endpoint: '/../etc' }, { endpoint: 'enrich' }, { requestDigest: 'z' },
    { validBefore: 0 }, { validBefore: 'soon' }, { network: 'eip155:0' }]) {
    assert.throws(() => l.prepare(input(bad), BODY), undefined, JSON.stringify(bad));
  }
  assert.throws(() => l.prepare(input(), Buffer.alloc(0)), /non-empty/);
  assert.throws(() => l.prepare(input(), 'string body'), /non-empty/);
  assert.throws(() => l.prepare(input(), Buffer.alloc(65, 1)), /exceeds limit/);
  assert.equal(l.sql('SELECT count(*) FROM prepared_fulfillments;'), '0');
}));

test('duplicate authorization with same binding never overwrites the first response', opt, () => withLedger({}, l => {
  const first = l.prepare(input(), BODY);
  const second = l.prepare(input(), Buffer.from('{"different":"body"}'));
  assert.equal(second.outcome, 'duplicate');
  assert.deepEqual(l.getResponse(first.record.authorizationId), BODY);
}));

test('same authorization with a different binding is a conflict and changes nothing', opt, () => withLedger({}, l => {
  const first = l.prepare(input(), BODY);
  for (const over of [{ requestDigest: 'f'.repeat(64) }, { amountAtomic: '2000' }, { payTo: '0x' + 'c'.repeat(40) }, { endpoint: '/enrich' }]) {
    const r = l.prepare(input(over), Buffer.from('x'));
    assert.equal(r.outcome, 'conflict', JSON.stringify(over));
  }
  assert.deepEqual(l.get(first.record.authorizationId), first.record);
  assert.equal(l.sql('SELECT count(*) FROM prepared_fulfillments;'), '1');
}));

test('concurrent prepares across 8 processes: exactly one wins', { ...opt, timeout: 60000 }, async () => {
  const { dir, db } = tmpdb();
  try {
    new PreparedLedger(db);
    const runs = Array.from({ length: 8 }, (_, i) => new Promise((resolve, reject) => {
      const c = spawn(process.execPath, [__filename], { env: { ...process.env, X402_PREPARED_RACE_CHILD: JSON.stringify({ db, i }) }, stdio: ['ignore', 'pipe', 'inherit'] });
      let out = ''; c.stdout.on('data', d => { out += d; });
      c.on('exit', code => code === 0 ? resolve(out.trim()) : reject(new Error('child ' + i + ' exit ' + code)));
    }));
    const outcomes = await Promise.all(runs);
    assert.equal(outcomes.filter(o => o === 'inserted').length, 1, outcomes.join(','));
    assert.equal(outcomes.filter(o => o === 'conflict').length, 7, outcomes.join(','));
    assert.equal(new PreparedLedger(db).sql('SELECT count(*) FROM prepared_fulfillments;'), '1');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('schema enforces immutability, no deletes, and evidence-backed terminal states', opt, () => withLedger({}, (l, db) => {
  const { record } = l.prepare(input(), BODY);
  const id = record.authorizationId;
  const raw = s => execFileSync('sqlite3', ['-bail', db], { input: s, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  for (const s of [`UPDATE prepared_fulfillments SET response_body=X'00' WHERE authorization_id='${id}';`,
    `UPDATE prepared_fulfillments SET payer='0x${'c'.repeat(40)}' WHERE authorization_id='${id}';`,
    `UPDATE prepared_fulfillments SET amount_atomic='1' WHERE authorization_id='${id}';`,
    `DELETE FROM prepared_fulfillments WHERE authorization_id='${id}';`,
    `UPDATE prepared_fulfillments SET state='RECONCILED_PAID' WHERE authorization_id='${id}';`,
    `UPDATE prepared_fulfillments SET state='PAID' WHERE authorization_id='${id}';`]) {
    assert.throws(() => raw(s), undefined, s);
  }
  assert.throws(() => raw(`INSERT INTO prepared_fulfillments (authorization_id,network,asset,pay_to,payer,amount_atomic,auth_nonce,valid_before,endpoint,request_digest,response_body,response_sha256)
    VALUES ('${'1'.repeat(64)}','${NET}','${ASSET}','${PAYTO}','${PAYER}','1','${NONCE}',1,'/x','${'e'.repeat(64)}',X'','${'0'.repeat(64)}');`), /CHECK/);
  assert.deepEqual(l.get(id), record);
}));

test('restart: a new ledger instance sees the same record and bytes; schema init is idempotent', opt, () => withLedger({}, (l, db) => {
  const { record } = l.prepare(input(), BODY);
  const reopened = new PreparedLedger(db);
  assert.deepEqual(reopened.get(record.authorizationId), record);
  assert.deepEqual(reopened.getResponse(record.authorizationId), BODY);
}));

test('write failure is surfaced as an exception (never a silent success)', opt, () => {
  const { dir, db } = tmpdb();
  const l = new PreparedLedger(db);
  fs.rmSync(dir, { recursive: true, force: true });
  assert.throws(() => l.prepare(input(), BODY));
});

test('facilitator success is recorded as FACILITATOR_SETTLED, never paid', opt, () => withLedger({}, l => {
  const { record } = l.prepare(input(), BODY);
  assert.equal(l.markFacilitatorSettled(record.authorizationId, { success: true, transaction: TX, network: NET, payer: PAYER }), true);
  const row = l.get(record.authorizationId);
  assert.equal(row.state, 'FACILITATOR_SETTLED');
  assert.equal(row.settlementTx, TX);
  assert.equal(l.markUnknown(record.authorizationId, 'late failure'), false, 'cannot regress to UNKNOWN');
}));

test('facilitator result disagreeing with the binding moves the record to EXCEPTION', opt, () => {
  for (const [over, reason] of [[{ payer: '0x' + 'c'.repeat(40) }, /payer/], [{ network: 'eip155:8453' }, /network/],
    [{ transaction: 'nope' }, /malformed/], [{ success: false }, /not successful/]]) {
    withLedger({}, l => {
      const { record } = l.prepare(input(), BODY);
      assert.equal(l.markFacilitatorSettled(record.authorizationId, { success: true, transaction: TX, network: NET, payer: PAYER, ...over }), true);
      const row = l.get(record.authorizationId);
      assert.equal(row.state, 'EXCEPTION');
      assert.match(row.reason, reason);
      assert.equal(row.settlementTx, null);
    });
  }
});

test('ambiguous outcomes become UNKNOWN (not unpaid), keep the response, and can still be settled', opt, () => withLedger({}, l => {
  const { record } = l.prepare(input(), BODY);
  assert.equal(l.markUnknown(record.authorizationId, 'facilitator: socket hang up'), true);
  assert.equal(l.get(record.authorizationId).state, 'UNKNOWN');
  assert.deepEqual(l.getResponse(record.authorizationId), BODY);
  assert.equal(l.markFacilitatorSettled(record.authorizationId, { success: true, transaction: TX, network: NET, payer: PAYER }), true);
}));

test('no reconciliation without an injected on-chain verifier', opt, () => withLedger({}, l => {
  const { record } = l.prepare(input(), BODY);
  l.markFacilitatorSettled(record.authorizationId, { success: true, transaction: TX, network: NET, payer: PAYER });
  assert.throws(() => l.reconcile(record.authorizationId), /no on-chain verifier/);
  assert.equal(l.get(record.authorizationId).state, 'FACILITATOR_SETTLED');
}));

test('facilitator-shaped or mismatched evidence can never reach RECONCILED_PAID', opt, () => {
  const facilitatorShaped = () => ({ success: true, transaction: TX, network: NET, payer: PAYER });
  const cases = [facilitatorShaped,
    row => evidence(row, { source: 'facilitator' }), row => evidence(row, { finalized: false }), row => evidence(row, { blockNumber: 0 }),
    row => evidence(row, { amountAtomic: '999' }), row => evidence(row, { payTo: '0x' + 'c'.repeat(40) }),
    row => evidence(row, { asset: '0x' + 'c'.repeat(40) }), row => evidence(row, { network: 'eip155:8453' }),
    row => evidence(row, { payer: '0x' + 'c'.repeat(40) }), row => evidence(row, { nonce: '0x' + '3'.repeat(64) }),
    row => evidence(row, { transferMatched: false }), row => evidence(row, { authorizationUsed: false }),
    row => evidence(row, { transaction: undefined })];
  for (const verifier of cases) {
    withLedger({ verifier }, l => {
      const { record } = l.prepare(input(), BODY);
      assert.throws(() => l.reconcile(record.authorizationId));
      assert.equal(l.get(record.authorizationId).state, 'PREPARED');
    });
  }
});

test('verified on-chain evidence reaches RECONCILED_PAID, which is final', opt, () => withLedger({ verifier: row => evidence(row) }, l => {
  const { record } = l.prepare(input(), BODY);
  l.markUnknown(record.authorizationId, 'facilitator: timeout');
  assert.equal(l.reconcile(record.authorizationId), true);
  const row = l.get(record.authorizationId);
  assert.equal(row.state, 'RECONCILED_PAID');
  assert.equal(row.settlementTx, TX);
  assert.equal(row.verifiedBlock, 123);
  assert.throws(() => l.reconcile(record.authorizationId), /not reconcilable/);
  assert.throws(() => l.transition(record.authorizationId, ['RECONCILED_PAID'], 'UNKNOWN', {}), /terminal/);
  assert.deepEqual(l.getResponse(record.authorizationId), BODY);
}));

test('on-chain tx differing from the facilitator-reported tx is an EXCEPTION, not paid', opt, () => withLedger({ verifier: row => evidence(row, { transaction: '0x' + 'f'.repeat(64) }) }, l => {
  const { record } = l.prepare(input(), BODY);
  l.markFacilitatorSettled(record.authorizationId, { success: true, transaction: TX, network: NET, payer: PAYER });
  assert.equal(l.reconcile(record.authorizationId), true);
  assert.equal(l.get(record.authorizationId).state, 'EXCEPTION');
}));

test('unpaid is concluded only after expiry with an unused authorization', opt, () => {
  let now = T0;
  const unpaid = row => evidence(row, { paid: false, authorizationUsed: false, transferMatched: false, transaction: undefined });
  withLedger({ verifier: unpaid, now: () => now }, l => {
    const { record } = l.prepare(input(), BODY);
    l.markUnknown(record.authorizationId, 'facilitator: settlement_pending');
    assert.throws(() => l.reconcile(record.authorizationId), /not yet expired/);
    assert.equal(l.get(record.authorizationId).state, 'UNKNOWN');
    now = T0 + 601;
    assert.equal(l.reconcile(record.authorizationId), true);
    assert.equal(l.get(record.authorizationId).state, 'RECONCILED_UNPAID');
  });
  withLedger({ verifier: row => evidence(row, { paid: false, authorizationUsed: true }), now: () => T0 + 10_000 }, l => {
    const { record } = l.prepare(input(), BODY);
    assert.throws(() => l.reconcile(record.authorizationId), /unused authorization/);
  });
});

if (CHILD && require.main === module) {
  const { db, i } = JSON.parse(CHILD);
  const r = new PreparedLedger(db).prepare(input({ requestDigest: crypto.createHash('sha256').update('req' + i).digest('hex') }), Buffer.from('body' + i));
  process.stdout.write(r.outcome + '\n');
}
