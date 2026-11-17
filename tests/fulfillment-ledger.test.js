'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const crypto=require('node:crypto');
const {spawnSync}=require('node:child_process');
const {FulfillmentLedger,requestDigest}=require('../lib/fulfillment-ledger');
const available=spawnSync('sqlite3',['-version'],{encoding:'utf8'}).status===0;
if (!available) throw new Error('sqlite3 CLI is required: refusing to silently skip ledger tests');
function fixture(t) {
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'x402-ledger-'));
 t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 return {db:path.join(dir,'ledger.sqlite'), ledger:new FulfillmentLedger(path.join(dir,'ledger.sqlite'))};
}
const settlementHash='a'.repeat(64);
const receipt={settlementHash,network:'eip155:84532',endpoint:'/contract-analysis',requestDigest:requestDigest({endpoint:'/contract-analysis',body:{contractText:'A'}})};
test('digest canonicalizes object key order and binds exact request',()=>{
 assert.equal(requestDigest({endpoint:'/contract-analysis',body:{a:1,b:2}}),requestDigest({endpoint:'/contract-analysis',body:{b:2,a:1}}));
 assert.notEqual(requestDigest({endpoint:'/contract-analysis',body:{contractText:'A'}}),requestDigest({endpoint:'/contract-analysis',body:{contractText:'B'}}));
 assert.notEqual(requestDigest({endpoint:'/contract-analysis'}),requestDigest({endpoint:'/enrich'}));
});
test('receipt binding rejects same settlement for other request or network',t=>{
 const {ledger}=fixture(t);ledger.recordVerified(receipt);
 assert.throws(()=>ledger.recordVerified({...receipt,network:'eip155:8453'}),/binding mismatch/);
 assert.throws(()=>ledger.recordVerified({...receipt,requestDigest:'b'.repeat(64)}),/binding mismatch/);
});
test('claim is exclusive across independent ledger instances',t=>{
 const {db,ledger}=fixture(t);ledger.recordVerified(receipt);
 const second=new FulfillmentLedger(db), token1=crypto.randomBytes(32).toString('hex'),token2=crypto.randomBytes(32).toString('hex');
 assert.equal(ledger.claim(receipt,token1),true);
 assert.equal(second.claim(receipt,token2),false);
 assert.equal(second.fulfill(settlementHash,token2,{ok:true}),false);
 assert.equal(ledger.fulfill(settlementHash,token1,{ok:true}),true);
 assert.equal(second.get(settlementHash).state,'FULFILLED');
 assert.equal(second.get(settlementHash).response,JSON.stringify({ok:true}));
 assert.equal(second.claim(receipt,token2),false);
});
test('restart retains CLAIMED; no unsafe automatic recomputation',t=>{
 const {db,ledger}=fixture(t);ledger.recordVerified(receipt);
 const token=crypto.randomBytes(32).toString('hex');
 assert.equal(ledger.claim(receipt,token),true);
 const afterRestart=new FulfillmentLedger(db);
 assert.equal(afterRestart.get(settlementHash).state,'CLAIMED');
 assert.equal(afterRestart.claim(receipt,crypto.randomBytes(32).toString('hex')),false);
 assert.equal(afterRestart.fulfill(settlementHash,token,{result:'durable'}),true);
 assert.equal(new FulfillmentLedger(db).get(settlementHash).state,'FULFILLED');
});
