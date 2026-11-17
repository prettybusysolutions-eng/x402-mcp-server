'use strict';
// Version-pinned integration probe: real Express + x402 middleware, fake facilitator.
// No RPC, wallet, real settlement, or production server.
const test=require('node:test');
const assert=require('node:assert/strict');
const express=require('express');
const {paymentMiddleware,x402ResourceServer}=require('@x402/express');
const {ExactEvmScheme}=require('@x402/evm/exact/server');
const NET='eip155:84532', PAYER='0x'+'b'.repeat(40), PAYTO='0x'+'d'.repeat(40), TX='0x'+'a'.repeat(64);
async function fixture(hooks={},settleImpl) {
 const events=[];
 const facilitator={
   calls:0,
   async getSupported(){return {kinds:[{x402Version:2,scheme:'exact',network:NET}],extensions:[],signers:{}};},
   async verify(){events.push('verify');return {isValid:true,payer:PAYER};},
   async settle(...args){this.calls++;events.push('settle');return settleImpl?settleImpl(...args):{success:true,transaction:TX,network:NET,payer:PAYER};}
 };
 const resource=new x402ResourceServer(facilitator).register(NET,new ExactEvmScheme());
 for(const [name,fn] of Object.entries(hooks))resource[name](fn);
 await resource.initialize();
 const app=express();app.use(express.json());
 app.use(paymentMiddleware({'POST /paid':{accepts:{scheme:'exact',price:'$0.001',network:NET,payTo:PAYTO},description:'lifecycle probe'}},resource,undefined,undefined,true));
 app.post('/paid',(_req,res)=>{events.push('handler');res.json({ok:true});});
 const listener=await new Promise(resolve=>{const l=app.listen(0,'127.0.0.1',()=>resolve(l));});
 const url='http://127.0.0.1:'+listener.address().port+'/paid';
 async function pay(){
  const first=await fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:'{}'});
  assert.equal(first.status,402);
  const required=JSON.parse(Buffer.from(first.headers.get('payment-required'),'base64').toString());
  const accepted=required.accepts[0];
  const payload={x402Version:2,resource:required.resource,accepted,payload:{signature:'0x'+'1'.repeat(130),authorization:{from:PAYER,to:accepted.payTo,value:accepted.amount,validAfter:'0',validBefore:String(Math.floor(Date.now()/1000)+600),nonce:'0x'+'2'.repeat(64)}}};
  const response=await fetch(url,{method:'POST',headers:{'content-type':'application/json','PAYMENT-SIGNATURE':Buffer.from(JSON.stringify(payload)).toString('base64')},body:'{"q":1}'});
  return {status:response.status,body:await response.text()};
 }
 return {events,facilitator,resource,pay,close:()=>new Promise(resolve=>listener.close(resolve))};
}
test('pinned installed packages and authorization flow',async()=>{
 const fs=require('node:fs'),path=require('node:path');
 for(const name of ['@x402/express','@x402/core','@x402/evm']){
  let dir=path.dirname(require.resolve(name)),version;
  for(let i=0;i<8;i++){const p=path.join(dir,'package.json');if(fs.existsSync(p)){const data=JSON.parse(fs.readFileSync(p));if(data.name===name){version=data.version;break;}}dir=path.dirname(dir);}
  assert.equal(version,'2.28.0',name);
 }
 const f=await fixture();try{
 assert.equal(f.resource.getPaymentFlow({},{scheme:'exact',network:NET,extra:{}}),'authorization');
 assert.equal(f.resource.getPaymentFlow({},{scheme:'exact',network:NET,extra:{paymentFlow:'upfront'}}),'upfront');
 }finally{await f.close();}
});
test('after-handler hook sees buffered response before settlement',async()=>{
 let seen;const events=[];
 const f=await fixture({
 onBeforeSettle:async ctx=>{events.push('before');seen=ctx;},
 onAfterSettle:async ctx=>{events.push('after');assert.equal(ctx.result.transaction,TX);}
 });
 try{const r=await f.pay();assert.equal(r.status,200);assert.deepEqual(JSON.parse(r.body),{ok:true});
 assert.equal(seen.phase,'after-handler');assert.ok(Buffer.isBuffer(seen.transportContext.responseBody));
 assert.deepEqual(JSON.parse(seen.transportContext.responseBody.toString()),{ok:true});
 assert.equal(seen.paymentPayload.payload.authorization.from,PAYER);
 assert.equal(seen.requirements.network,NET);assert.equal(seen.requirements.payTo,PAYTO);
 assert.deepEqual(f.events,['verify','handler','settle']);assert.deepEqual(events,['before','after']);
 }finally{await f.close();}
});
test('explicit abort prevents settlement',async()=>{
 const f=await fixture({onBeforeSettle:async()=>({abort:true,reason:'prepare_failed',message:'failed'})});
 try{const r=await f.pay();assert.equal(r.status,402);assert.equal(f.facilitator.calls,0);assert.ok(!r.body.includes('"ok":true'));}finally{await f.close();}
});
test('thrown pre-settle hook does NOT prevent settlement',async()=>{
 const f=await fixture({onBeforeSettle:async()=>{throw Error('db unavailable');}});
 try{const r=await f.pay();assert.equal(r.status,200);assert.equal(f.facilitator.calls,1);}finally{await f.close();}
});
test('thrown after-settle hook does NOT block response',async()=>{
 const f=await fixture({onAfterSettle:async()=>{throw Error('db unavailable');}});
 try{const r=await f.pay();assert.equal(r.status,200);assert.equal(f.facilitator.calls,1);}finally{await f.close();}
});
test('ambiguous facilitator error yields 402 and no handler output',async()=>{
 const f=await fixture({},()=>{throw Error('socket hang up');});
 try{const r=await f.pay();assert.equal(r.status,402);assert.equal(f.facilitator.calls,1);assert.ok(!r.body.includes('"ok":true'));}finally{await f.close();}
});
test('settlement_pending yields 402 after two attempts',async()=>{
 const f=await fixture({},()=>({success:false,errorReason:'settlement_pending',transaction:TX,network:NET,payer:PAYER}));
 try{const r=await f.pay();assert.equal(r.status,402);assert.equal(f.facilitator.calls,2);}finally{await f.close();}
});
