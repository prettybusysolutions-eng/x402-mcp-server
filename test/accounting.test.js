const assert=require('node:assert/strict');
const test=require('node:test');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {execFileSync,spawnSync}=require('node:child_process');
const directory=fs.mkdtempSync(path.join(os.tmpdir(),'x402-accounting-'));
const database=path.join(directory,'requests.sqlite');
process.env.X402_REQUEST_LOG_DB=database;
process.env.X402_NETWORK='eip155:8453';
const {ensureRequestLogDb,insertRequestLog,settledPreflightSales}=require('../server');
const available=spawnSync('sqlite3',['--version']).status===0;
test('durable accounting excludes replay, self-payment, failure and foreign networks',{skip:!available},()=>{
  try {
    ensureRequestLogDb();ensureRequestLogDb();
    const base={ts:new Date().toISOString(),method:'POST',endpoint:'/revenue-friction-preflight',
      statusCode:200,hasPayment:true,payerAddress:'0x'+'b'.repeat(40),settlementTxHash:'0x'+'a'.repeat(64)};
    insertRequestLog(base);insertRequestLog(base);
    insertRequestLog({...base,statusCode:500,settlementTxHash:'0x'+'c'.repeat(64)});
    insertRequestLog({...base,payerAddress:'0x75aAbC3D213fBC8482f0bA2aEc36ad184301B50a',settlementTxHash:'0x'+'d'.repeat(64)});
    insertRequestLog({...base,payerAddress:null,settlementTxHash:'0x'+'e'.repeat(64)});
    execFileSync('sqlite3',[database,"INSERT INTO request_log(ts,endpoint,status_code,payer_address,settlement_tx_hash,network) VALUES('test','/revenue-friction-preflight',200,'external','foreign','eip155:84532');"]);
    assert.equal(settledPreflightSales(),1);
    execFileSync('sqlite3',[database,'DROP TABLE request_log;']);
    assert.equal(settledPreflightSales(),null);
  } finally {fs.rmSync(directory,{recursive:true,force:true})}
});
