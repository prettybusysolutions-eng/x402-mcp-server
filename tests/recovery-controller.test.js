'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const {issueRecoveryToken}=require('../lib/recovery-capability');
const {createRecoveryHandler}=require('../lib/recovery-controller');
const key=crypto.randomBytes(32);
const row={settlementHash:'a'.repeat(64),requestDigest:'b'.repeat(64),network:'eip155:84532',endpoint:'/contract-analysis',state:'FULFILLED',response:JSON.stringify({ok:true,contract:'A'})};
function invoke(record,token,hash=row.settlementHash,network=row.network) {
 const handler=createRecoveryHandler({ledger:{get:()=>record},key,network});
 const result={statusCode:200,headers:{}};
 const res={set(k,v){result.headers[k]=v;return this;},status(v){result.statusCode=v;return this;},json(v){result.body=v;return this;},type(v){result.type=v;return this;},send(v){result.body=v;return this;}};
 handler({get:(k)=>k==='X-Recovery-Token'?token:undefined,body:{settlementHash:hash}},res);
 return result;
}
function token(binding=row) {return issueRecoveryToken({...binding,expiresAt:Math.floor(Date.now()/1000)+120},key);}
test('returns cached response only for valid token and fulfilled record',()=>{
 const r=invoke(row,token());assert.equal(r.statusCode,200);
 assert.equal(JSON.parse(r.body).contract,'A');assert.equal(r.headers['Cache-Control'],'no-store');
});
test('rejects missing token, wrong chain, and wrong digest',()=>{
 assert.equal(invoke(row,null).statusCode,401);
 assert.equal(invoke(row,token(),row.settlementHash,'eip155:8453').statusCode,401);
 assert.equal(invoke({...row,requestDigest:'c'.repeat(64)},token()).statusCode,401);
 assert.equal(invoke(null,token()).statusCode,401);
});
test('never computes or recharges on CLAIMED or VERIFIED',()=>{
 for(const state of ['CLAIMED','VERIFIED','FAILED']) {
  const r=invoke({...row,state},token());assert.equal(r.statusCode,202);
  assert.equal(r.body.state,'PENDING_RECONCILIATION');
 }
});
test('fail closed on ledger exception',()=>{
 const handler=createRecoveryHandler({ledger:{get(){throw Error('db unavailable');}},key,network:row.network});
 let status=0;
 const res={set(){return this;},status(s){status=s;return this;},json(){return this;}};
 handler({get:()=>token(),body:{settlementHash:row.settlementHash}},res);
 assert.equal(status,503);
});
