'use strict';
// Version-pinned integration probe: real Express + x402 middleware, fake facilitator.
// No RPC, wallet, real settlement, or production server.
const CHILD=!!process.env.X402_LIFECYCLE_CRASH_CHILD;
const test=CHILD?()=>{}:require('node:test');
const assert=require('node:assert/strict');
const express=require('express');
const {paymentMiddleware,x402ResourceServer}=require('@x402/express');
const {ExactEvmScheme}=require('@x402/evm/exact/server');
const NET='eip155:84532', PAYER='0x'+'b'.repeat(40), PAYTO='0x'+'d'.repeat(40), TX='0x'+'a'.repeat(64);
async function fixture(hooks={},settleImpl,opts={}) {
 const events=[];
 if(typeof hooks==='function')hooks=hooks(events);
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
 app.post('/paid',(_req,res)=>{events.push('handler');if(opts.handler)return opts.handler(res);res.json({ok:true});});
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
 return {events,facilitator,resource,pay,url,close:()=>new Promise(resolve=>listener.close(resolve))};
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
 let seen;
 const f=await fixture(events=>({
 onBeforeSettle:async ctx=>{events.push('before');seen=ctx;},
 onAfterSettle:async ctx=>{events.push('after');assert.equal(ctx.result.transaction,TX);
  assert.deepEqual(Object.keys(ctx.result).sort(),['network','payer','success','transaction']);}
 }));
 try{const r=await f.pay();assert.equal(r.status,200);assert.deepEqual(JSON.parse(r.body),{ok:true});
 assert.equal(seen.phase,'after-handler');assert.ok(Buffer.isBuffer(seen.transportContext.responseBody));
 assert.deepEqual(JSON.parse(seen.transportContext.responseBody.toString()),{ok:true});
 assert.equal(seen.paymentPayload.payload.authorization.from,PAYER);
 assert.equal(seen.requirements.network,NET);assert.equal(seen.requirements.payTo,PAYTO);
 assert.deepEqual(f.events,['verify','handler','before','settle','after'],'interleaved order: pre-settle hook strictly before facilitator settle');
 assert.deepEqual(Object.keys(seen).sort(),['declaredExtensions','paymentPayload','phase','requirements','transportContext']);
 assert.deepEqual(Object.keys(seen.transportContext).sort(),['request','responseBody','responseHeaders']);
 assert.equal(seen.paymentPayload.payload.authorization.nonce,'0x'+'2'.repeat(64));
 assert.match(String(seen.requirements.amount),/^[0-9]+$/);assert.match(seen.requirements.asset,/^0x[0-9a-fA-F]{40}$/);
 }finally{await f.close();}
});
test('explicit abort prevents settlement',async()=>{
 const f=await fixture(events=>({onBeforeSettle:async()=>{events.push('before');return {abort:true,reason:'prepare_failed',message:'failed'};},
  onSettleFailure:async()=>{events.push('settleFailure');},onAfterSettle:async()=>{events.push('after');},
  onVerifiedPaymentCanceled:async ctx=>{events.push('canceled:'+ctx.reason);}}));
 try{const r=await f.pay();assert.equal(r.status,402);assert.equal(f.facilitator.calls,0);assert.ok(!r.body.includes('"ok":true'));
 assert.deepEqual(f.events,['verify','handler','before'],'abort runs no failure, after-settle or cancellation hook');}finally{await f.close();}
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
 let failure;const f=await fixture({onSettleFailure:async ctx=>{failure=ctx.error.message;}},()=>{throw Error('socket hang up');});
 try{const r=await f.pay();assert.equal(r.status,402);assert.equal(f.facilitator.calls,1);assert.ok(!r.body.includes('"ok":true'));assert.equal(failure,'socket hang up');}finally{await f.close();}
});
test('settlement_pending yields 402 after two attempts',async()=>{
 const f=await fixture({},()=>({success:false,errorReason:'settlement_pending',transaction:TX,network:NET,payer:PAYER}));
 try{const r=await f.pay();assert.equal(r.status,402);assert.equal(f.facilitator.calls,2);}finally{await f.close();}
});
test('handler 5xx cancels verified payment without settling',async()=>{
 const f=await fixture(events=>({onBeforeSettle:async()=>{events.push('before');},onVerifiedPaymentCanceled:async ctx=>{events.push('canceled:'+ctx.reason);}}),
  undefined,{handler:res=>res.status(500).json({error:'boom'})});
 try{const r=await f.pay();assert.equal(r.status,500);assert.equal(f.facilitator.calls,0);
 assert.deepEqual(f.events,['verify','handler','canceled:handler_failed']);}finally{await f.close();}
});
test('handler throw cancels verified payment without settling',async()=>{
 const f=await fixture(events=>({onBeforeSettle:async()=>{events.push('before');},onVerifiedPaymentCanceled:async ctx=>{events.push('canceled:'+ctx.reason);}}),
  undefined,{handler:()=>{throw Error('handler crashed');}});
 try{const r=await f.pay();assert.equal(f.facilitator.calls,0);assert.equal(r.status,500);
 // Express 5 catches the throw and renders 500 before the x402 wrapper sees it: reason is handler_failed, not handler_threw.
 assert.deepEqual(f.events,['verify','handler','canceled:handler_failed']);}finally{await f.close();}
});
test('crash after facilitator success, before delivery: fsynced PREPARED record survives',{timeout:20000},async()=>{
 const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{spawn}=require('node:child_process');
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'x402-crash-')),record=path.join(dir,'prepared.json');
 const child=spawn(process.execPath,[__filename],{env:{...process.env,X402_LIFECYCLE_CRASH_CHILD:record},stdio:['ignore','pipe','inherit']});
 try{
  const port=await new Promise((resolve,reject)=>{let b='';child.stdout.on('data',d=>{b+=d;const m=b.match(/LISTENING (\d+)/);if(m)resolve(m[1]);});child.on('exit',c=>reject(Error('child exited early '+c)));});
  let outcome;try{const r=await crashPay('http://127.0.0.1:'+port+'/paid');outcome='status '+r;}catch{outcome='transport error';}
  assert.equal(outcome,'transport error','buyer receives no response after the charge');
  const signal=await new Promise(r=>child.exitCode!==null||child.signalCode?r(child.signalCode):child.on('exit',(_c,s)=>r(s)));
  assert.equal(signal,'SIGKILL');
  const p=JSON.parse(fs.readFileSync(record,'utf8'));
  assert.equal(p.state,'PREPARED');assert.equal(p.payer,PAYER);assert.equal(p.nonce,'0x'+'2'.repeat(64));
  assert.deepEqual(JSON.parse(p.responseBody),{ok:true},'persisted response recoverable without recompute');
 }finally{child.kill('SIGKILL');fs.rmSync(dir,{recursive:true,force:true});}
});
async function crashPay(url){
 const first=await fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:'{}'});
 const required=JSON.parse(Buffer.from(first.headers.get('payment-required'),'base64').toString());const accepted=required.accepts[0];
 const payload={x402Version:2,resource:required.resource,accepted,payload:{signature:'0x'+'1'.repeat(130),authorization:{from:PAYER,to:accepted.payTo,value:accepted.amount,validAfter:'0',validBefore:String(Math.floor(Date.now()/1000)+600),nonce:'0x'+'2'.repeat(64)}}};
 const r=await fetch(url,{method:'POST',headers:{'content-type':'application/json','PAYMENT-SIGNATURE':Buffer.from(JSON.stringify(payload)).toString('base64')},body:'{"q":1}'});
 return r.status;
}
// Crash child: durable fsynced write in onBeforeSettle (abort on failure); SIGKILL inside onAfterSettle,
// i.e. after facilitator success and before the buffered body is flushed.
if(CHILD&&require.main===module){
 const fs=require('node:fs'),record=process.env.X402_LIFECYCLE_CRASH_CHILD;
 fixture({
  onBeforeSettle:async ctx=>{try{const a=ctx.paymentPayload.payload.authorization;
   const fd=fs.openSync(record,'w');fs.writeSync(fd,JSON.stringify({state:'PREPARED',payer:a.from,nonce:a.nonce,responseBody:ctx.transportContext.responseBody.toString('utf8')}));fs.fsyncSync(fd);fs.closeSync(fd);
  }catch(e){return {abort:true,reason:'prepare_failed',message:String(e?.message||e)};}},
  onAfterSettle:async()=>{process.kill(process.pid,'SIGKILL');}
 }).then(f=>process.stdout.write('LISTENING '+new URL(f.url).port+'\n'));
}
