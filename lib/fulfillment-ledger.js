'use strict';
// STAGING ONLY. This module does not validate x402 receipts or authorize recovery.
// Call recordVerified ONLY after independent, trusted settlement verification.
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
function canonical(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(v => { if (v === undefined) throw Error('undefined array member'); return canonical(v); }).join(',') + ']';
  if (value && Object.getPrototypeOf(value) === Object.prototype) {
    return '{' + Object.keys(value).sort().map(k => {
      if (value[k] === undefined) throw Error('undefined field');
      return JSON.stringify(k) + ':' + canonical(value[k]);
    }).join(',') + '}';
  }
  throw Error('unsupported canonical input');
}
function requestDigest({ method = 'POST', endpoint, query = {}, body = {} }) {
  if (typeof endpoint !== 'string' || !endpoint.startsWith('/')) throw Error('invalid endpoint');
  return crypto.createHash('sha256').update(canonical({method:method.toUpperCase(),endpoint,query,body})).digest('hex');
}
function sql(v) { return "'" + String(v).replace(/'/g,"''") + "'"; }
function assertHash(v) { if (!/^(0x)?[a-fA-F0-9]{64}$/.test(v || '')) throw Error('invalid hash'); return v.toLowerCase(); }
class FulfillmentLedger {
  constructor(dbPath) {
    if (!dbPath) throw Error('db path required');
    this.dbPath = dbPath;
    this.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS fulfillment_states (
        settlement_hash TEXT PRIMARY KEY,
        network TEXT NOT NULL,
        endpoint TEXT NOT NULL,
        request_digest TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('VERIFIED','CLAIMED','FULFILLED','FAILED')),
        claim_token_hash TEXT,
        claimed_at INTEGER,
        response_json TEXT,
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
        CHECK(state != 'FULFILLED' OR response_json IS NOT NULL)
      );`);
  }
  exec(statement) {
    return execFileSync('sqlite3',['-batch','-noheader',this.dbPath,statement],{encoding:'utf8',timeout:8000}).trim();
  }
  transaction(statement) {
    // Each invocation runs in a single SQLite process and transaction. Busy errors fail closed.
    return this.exec(`PRAGMA busy_timeout=5000; BEGIN IMMEDIATE; ${statement} COMMIT;`);
  }
  get(hash) {
    const h=assertHash(hash);
    const raw=this.exec(`SELECT json_object('settlementHash',settlement_hash,'network',network,'endpoint',endpoint,'requestDigest',request_digest,'state',state,'claimedAt',claimed_at,'response',response_json) FROM fulfillment_states WHERE settlement_hash=${sql(h)};`);
    return raw ? JSON.parse(raw) : null;
  }
  recordVerified(receipt) {
    // IMPORTANT: receipt must come from a trusted server-side verification adapter, never req.headers.
    const h=assertHash(receipt.settlementHash), d=assertHash(receipt.requestDigest);
    if (!/^eip155:[0-9]+$/.test(receipt.network || '') || !/^\/[a-z0-9/-]+$/.test(receipt.endpoint || '')) throw Error('invalid receipt binding');
    const existing=this.get(h);
    if (existing && (existing.network!==receipt.network || existing.endpoint!==receipt.endpoint || existing.requestDigest!==d)) throw Error('settlement binding mismatch');
    this.transaction(`INSERT OR IGNORE INTO fulfillment_states(settlement_hash,network,endpoint,request_digest,state)
      VALUES(${sql(h)},${sql(receipt.network)},${sql(receipt.endpoint)},${sql(d)},'VERIFIED');`);
    const row=this.get(h);
    if (row.network!==receipt.network || row.endpoint!==receipt.endpoint || row.requestDigest!==d) throw Error('settlement binding mismatch');
    return row;
  }
  claim(receipt, token) {
    const h=assertHash(receipt.settlementHash), d=assertHash(receipt.requestDigest);
    if (typeof token!=='string' || token.length<32) throw Error('strong random claim token required');
    const th=crypto.createHash('sha256').update(token).digest('hex');
    // Atomic CAS. No automatic reclaim of CLAIMED: operator/verified recovery must reconcile first.
    const result=this.transaction(`UPDATE fulfillment_states SET state='CLAIMED',claim_token_hash=${sql(th)},claimed_at=unixepoch(),updated_at=unixepoch()
      WHERE settlement_hash=${sql(h)} AND network=${sql(receipt.network)} AND endpoint=${sql(receipt.endpoint)}
        AND request_digest=${sql(d)} AND state='VERIFIED';
      SELECT changes();`);
    return result.split('\n').at(-1)==='1';
  }
  fulfill(hash, token, response) {
    const h=assertHash(hash);
    const th=crypto.createHash('sha256').update(token).digest('hex');
    const body=canonical(response);
    const result=this.transaction(`UPDATE fulfillment_states SET state='FULFILLED',response_json=${sql(body)},updated_at=unixepoch()
      WHERE settlement_hash=${sql(h)} AND claim_token_hash=${sql(th)} AND state='CLAIMED';
      SELECT changes();`);
    return result.split('\n').at(-1)==='1';
  }
}
module.exports={canonical,requestDigest,FulfillmentLedger};
