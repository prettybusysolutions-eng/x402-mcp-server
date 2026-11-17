'use strict';
// STAGING ONLY. Durable PREPARED ledger for pre-settlement fulfillment (issue #41). EIP-3009 only.
// NOT wired into server.js. Facilitator data can never move a record to RECONCILED_PAID: only an
// injected on-chain verifier can, and its output is re-checked here against the stored binding.
//
// SQL is sent to the sqlite3 CLI over stdin (never argv): response bodies can exceed the 128 KiB
// per-argument limit on Linux. Every mutation is a single BEGIN IMMEDIATE transaction.
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const DOMAIN = 'x402-prepared-ledger/v1';
const MAX_RESPONSE_BYTES = 1024 * 1024;
const STATES = ['PREPARED', 'FACILITATOR_SETTLED', 'UNKNOWN', 'RECONCILED_PAID', 'RECONCILED_UNPAID', 'EXCEPTION'];
const TERMINAL = ['RECONCILED_PAID', 'RECONCILED_UNPAID', 'EXCEPTION'];

const RE = {
  network: /^eip155:[1-9][0-9]*$/,
  address: /^0x[0-9a-f]{40}$/,
  nonce: /^0x[0-9a-f]{64}$/,
  hash: /^[0-9a-f]{64}$/,
  tx: /^0x[0-9a-f]{64}$/,
  atomic: /^(0|[1-9][0-9]*)$/,
  endpoint: /^\/[a-z0-9/-]+$/,
};

function need(cond, msg) { if (!cond) throw new Error(msg); }
function lower(v) { return typeof v === 'string' ? v.toLowerCase() : v; }
function q(v) { return v === null || v === undefined ? 'NULL' : "'" + String(v).replace(/'/g, "''") + "'"; }

// EIP-3009 nonces are unique per (chain, token contract, authorizer). Domain-separated so the id
// cannot collide with any other hash in this codebase.
function authorizationId({ network, asset, payer, nonce }) {
  const n = network, a = lower(asset), p = lower(payer), k = lower(nonce);
  need(RE.network.test(n || ''), 'invalid network');
  need(RE.address.test(a || ''), 'invalid asset');
  need(RE.address.test(p || ''), 'invalid payer');
  need(RE.nonce.test(k || ''), 'invalid authorization nonce');
  return crypto.createHash('sha256').update([DOMAIN, n, a, p, k].join('\n')).digest('hex');
}

const SCHEMA = `
PRAGMA journal_mode=WAL;
CREATE TABLE IF NOT EXISTS prepared_fulfillments (
  authorization_id TEXT PRIMARY KEY CHECK (length(authorization_id)=64 AND authorization_id NOT GLOB '*[^0-9a-f]*'),
  network        TEXT NOT NULL CHECK (network GLOB 'eip155:[1-9]*' AND substr(network,8) NOT GLOB '*[^0-9]*'),
  asset          TEXT NOT NULL CHECK (length(asset)=42 AND asset GLOB '0x*' AND substr(asset,3) NOT GLOB '*[^0-9a-f]*'),
  pay_to         TEXT NOT NULL CHECK (length(pay_to)=42 AND pay_to GLOB '0x*' AND substr(pay_to,3) NOT GLOB '*[^0-9a-f]*'),
  payer          TEXT NOT NULL CHECK (length(payer)=42 AND payer GLOB '0x*' AND substr(payer,3) NOT GLOB '*[^0-9a-f]*'),
  amount_atomic  TEXT NOT NULL CHECK (length(amount_atomic)>0 AND amount_atomic NOT GLOB '*[^0-9]*' AND (amount_atomic='0' OR amount_atomic NOT GLOB '0*')),
  auth_nonce     TEXT NOT NULL CHECK (length(auth_nonce)=66 AND auth_nonce GLOB '0x*' AND substr(auth_nonce,3) NOT GLOB '*[^0-9a-f]*'),
  valid_before   INTEGER NOT NULL CHECK (valid_before > 0),
  endpoint       TEXT NOT NULL CHECK (endpoint GLOB '/*'),
  request_digest TEXT NOT NULL CHECK (length(request_digest)=64 AND request_digest NOT GLOB '*[^0-9a-f]*'),
  response_body  BLOB NOT NULL CHECK (typeof(response_body)='blob' AND length(response_body)>0),
  response_sha256 TEXT NOT NULL CHECK (length(response_sha256)=64 AND response_sha256 NOT GLOB '*[^0-9a-f]*'),
  state          TEXT NOT NULL DEFAULT 'PREPARED' CHECK (state IN (${STATES.map(q).join(',')})),
  reason         TEXT,
  settlement_tx  TEXT CHECK (settlement_tx IS NULL OR (length(settlement_tx)=66 AND settlement_tx GLOB '0x*' AND substr(settlement_tx,3) NOT GLOB '*[^0-9a-f]*')),
  verified_block INTEGER,
  created_at     INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at     INTEGER NOT NULL DEFAULT (unixepoch()),
  CHECK (state != 'RECONCILED_PAID' OR (settlement_tx IS NOT NULL AND verified_block IS NOT NULL)),
  CHECK (state != 'RECONCILED_UNPAID' OR verified_block IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_prepared_state ON prepared_fulfillments(state);
CREATE INDEX IF NOT EXISTS idx_prepared_payer ON prepared_fulfillments(payer);
-- The purchase binding and the persisted response are immutable once written.
CREATE TRIGGER IF NOT EXISTS prepared_immutable_binding
BEFORE UPDATE OF authorization_id, network, asset, pay_to, payer, amount_atomic, auth_nonce, valid_before,
  endpoint, request_digest, response_body, response_sha256, created_at ON prepared_fulfillments
BEGIN SELECT RAISE(ABORT, 'prepared binding is immutable'); END;
-- Terminal states never change.
CREATE TRIGGER IF NOT EXISTS prepared_terminal_states
BEFORE UPDATE OF state ON prepared_fulfillments
WHEN OLD.state IN (${TERMINAL.map(q).join(',')})
BEGIN SELECT RAISE(ABORT, 'terminal state is final'); END;
CREATE TRIGGER IF NOT EXISTS prepared_no_delete
BEFORE DELETE ON prepared_fulfillments
BEGIN SELECT RAISE(ABORT, 'prepared records are never deleted'); END;
`;

const ROW = `json_object('authorizationId',authorization_id,'network',network,'asset',asset,'payTo',pay_to,
  'payer',payer,'amountAtomic',amount_atomic,'nonce',auth_nonce,'validBefore',valid_before,'endpoint',endpoint,
  'requestDigest',request_digest,'responseSha256',response_sha256,'responseBytes',length(response_body),
  'state',state,'reason',reason,'settlementTx',settlement_tx,'verifiedBlock',verified_block)`;

class PreparedLedger {
  constructor(dbPath, { verifier = null, now = () => Math.floor(Date.now() / 1000), maxResponseBytes = MAX_RESPONSE_BYTES } = {}) {
    need(typeof dbPath === 'string' && dbPath.length > 0, 'db path required');
    this.dbPath = dbPath;
    this.verifier = verifier;
    this.now = now;
    this.maxResponseBytes = maxResponseBytes;
    this.sql(SCHEMA);
  }

  sql(statement) {
    return execFileSync('sqlite3', ['-batch', '-noheader', '-bail', this.dbPath], {
      input: `.timeout 5000\n${statement}\n`, encoding: 'utf8', timeout: 10000, maxBuffer: 8 * 1024 * 1024,
      stdio: ['pipe', 'pipe', 'pipe'], // sqlite stderr is carried in the thrown error, not leaked to the log
    }).trim();
  }

  tx(statement) { return this.sql(`BEGIN IMMEDIATE;\n${statement}\nCOMMIT;`); }

  get(id) {
    need(RE.hash.test(id || ''), 'invalid authorization id');
    const raw = this.sql(`SELECT ${ROW} FROM prepared_fulfillments WHERE authorization_id=${q(id)};`);
    return raw ? JSON.parse(raw) : null;
  }

  // Returns the stored response bytes after re-verifying their digest.
  getResponse(id) {
    need(RE.hash.test(id || ''), 'invalid authorization id');
    const raw = this.sql(`SELECT hex(response_body)||'|'||response_sha256 FROM prepared_fulfillments WHERE authorization_id=${q(id)};`);
    if (!raw) return null;
    const [hex, sha] = raw.split('|');
    const body = Buffer.from(hex, 'hex');
    need(crypto.createHash('sha256').update(body).digest('hex') === sha, 'stored response integrity failure');
    return body;
  }

  // Validates and normalizes a prepare request. Throws on anything malformed.
  static normalize(input) {
    need(input && typeof input === 'object', 'prepare input required');
    const r = {
      network: input.network,
      asset: lower(input.asset),
      payTo: lower(input.payTo),
      payer: lower(input.payer),
      amountAtomic: String(input.amountAtomic ?? ''),
      nonce: lower(input.nonce),
      validBefore: Number(input.validBefore),
      endpoint: input.endpoint,
      requestDigest: lower(input.requestDigest),
    };
    need(RE.network.test(r.network || ''), 'invalid network');
    need(RE.address.test(r.asset || ''), 'invalid asset');
    need(RE.address.test(r.payTo || ''), 'invalid payTo');
    need(RE.address.test(r.payer || ''), 'invalid payer');
    need(RE.atomic.test(r.amountAtomic), 'invalid atomic amount');
    need(RE.nonce.test(r.nonce || ''), 'invalid authorization nonce');
    need(Number.isSafeInteger(r.validBefore) && r.validBefore > 0, 'invalid validBefore');
    need(RE.endpoint.test(r.endpoint || ''), 'invalid endpoint');
    need(RE.hash.test(r.requestDigest || ''), 'invalid request digest');
    r.authorizationId = authorizationId(r);
    return r;
  }

  // Atomically inserts a PREPARED record. Never overwrites.
  // outcome: 'inserted' | 'duplicate' (same binding already stored) | 'conflict' (same authorization, different binding)
  prepare(input, responseBody) {
    const r = PreparedLedger.normalize(input);
    need(Buffer.isBuffer(responseBody) && responseBody.length > 0, 'non-empty response body required');
    need(responseBody.length <= this.maxResponseBytes, 'response body exceeds limit');
    const sha = crypto.createHash('sha256').update(responseBody).digest('hex');
    const out = this.tx(`INSERT INTO prepared_fulfillments
      (authorization_id,network,asset,pay_to,payer,amount_atomic,auth_nonce,valid_before,endpoint,request_digest,response_body,response_sha256)
      VALUES (${q(r.authorizationId)},${q(r.network)},${q(r.asset)},${q(r.payTo)},${q(r.payer)},${q(r.amountAtomic)},${q(r.nonce)},
        ${r.validBefore},${q(r.endpoint)},${q(r.requestDigest)},X'${responseBody.toString('hex')}',${q(sha)})
      ON CONFLICT(authorization_id) DO NOTHING;
      SELECT changes();`);
    const inserted = out.split('\n').at(-1) === '1';
    const record = this.get(r.authorizationId);
    need(record, 'prepared record missing after commit');
    if (inserted) return { outcome: 'inserted', record };
    const same = ['network', 'asset', 'payTo', 'payer', 'amountAtomic', 'nonce', 'validBefore', 'endpoint', 'requestDigest']
      .every(k => record[k] === r[k]);
    return { outcome: same ? 'duplicate' : 'conflict', record };
  }

  // Best-effort record of what the facilitator CLAIMS. Never establishes payment.
  // A facilitator result that disagrees with the stored binding moves the record to EXCEPTION.
  markFacilitatorSettled(id, result) {
    const row = this.get(id);
    need(row, 'unknown authorization id');
    const tx = lower(result?.transaction);
    const mismatch = !result || result.success !== true ? 'facilitator result not successful'
      : !RE.tx.test(tx || '') ? 'facilitator transaction malformed'
      : result.network !== row.network ? 'facilitator network mismatch'
      : lower(result.payer) !== row.payer ? 'facilitator payer mismatch'
      : null;
    if (mismatch) return this.transition(id, ['PREPARED', 'UNKNOWN'], 'EXCEPTION', { reason: mismatch });
    return this.transition(id, ['PREPARED', 'UNKNOWN'], 'FACILITATOR_SETTLED', { settlementTx: tx, reason: null });
  }

  // Ambiguous or failed facilitator outcome. The payment MAY have happened; never treated as unpaid.
  markUnknown(id, reason) {
    need(typeof reason === 'string' && reason.length > 0, 'reason required');
    return this.transition(id, ['PREPARED'], 'UNKNOWN', { reason: reason.slice(0, 500) });
  }

  // Only path to RECONCILED_*: an injected on-chain verifier whose evidence matches the stored binding.
  reconcile(id) {
    const row = this.get(id);
    need(row, 'unknown authorization id');
    need(['PREPARED', 'FACILITATOR_SETTLED', 'UNKNOWN'].includes(row.state), 'record not reconcilable in state ' + row.state);
    need(typeof this.verifier === 'function', 'no on-chain verifier configured; refusing to reconcile');
    const ev = this.verifier(Object.freeze({ ...row }));
    need(ev && ev.source === 'onchain-receipt', 'evidence must come from on-chain receipt verification');
    need(Number.isSafeInteger(ev.blockNumber) && ev.blockNumber > 0, 'evidence block required');
    need(ev.finalized === true, 'evidence not final');
    for (const k of ['network', 'asset', 'payTo', 'payer', 'amountAtomic', 'nonce']) {
      need(lower(ev[k]) === row[k], 'evidence ' + k + ' mismatch');
    }
    if (ev.paid === true) {
      const tx = lower(ev.transaction);
      need(RE.tx.test(tx || ''), 'evidence transaction required');
      need(ev.authorizationUsed === true && ev.transferMatched === true, 'evidence must match AuthorizationUsed and Transfer');
      if (row.settlementTx && row.settlementTx !== tx) {
        return this.transition(id, [row.state], 'EXCEPTION', { reason: 'on-chain tx differs from facilitator tx', verifiedBlock: ev.blockNumber });
      }
      return this.transition(id, [row.state], 'RECONCILED_PAID', { settlementTx: tx, verifiedBlock: ev.blockNumber, reason: null });
    }
    need(ev.paid === false, 'evidence paid flag required');
    // An unused authorization can still be submitted until validBefore. Unpaid is only final after expiry.
    need(ev.authorizationUsed === false, 'unpaid evidence requires an unused authorization');
    need(this.now() > row.validBefore, 'authorization not yet expired; cannot conclude unpaid');
    return this.transition(id, [row.state], 'RECONCILED_UNPAID', { verifiedBlock: ev.blockNumber, reason: null });
  }

  // Atomic compare-and-set. Returns true iff exactly this transition happened.
  transition(id, from, to, { reason, settlementTx, verifiedBlock } = {}) {
    need(RE.hash.test(id || ''), 'invalid authorization id');
    need(STATES.includes(to) && from.every(s => STATES.includes(s)), 'invalid state');
    const sets = [`state=${q(to)}`, 'updated_at=unixepoch()'];
    if (reason !== undefined) sets.push(`reason=${q(reason)}`);
    if (settlementTx !== undefined) sets.push(`settlement_tx=${q(settlementTx)}`);
    if (verifiedBlock !== undefined) sets.push(`verified_block=${Number(verifiedBlock)}`);
    const out = this.tx(`UPDATE prepared_fulfillments SET ${sets.join(',')}
      WHERE authorization_id=${q(id)} AND state IN (${from.map(q).join(',')});
      SELECT changes();`);
    return out.split('\n').at(-1) === '1';
  }
}

module.exports = { PreparedLedger, authorizationId, STATES, MAX_RESPONSE_BYTES };
