'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {verifiedReceiptFromTrustedSettlement: adapt}=require('../lib/facilitator-adapter');
const request={method:'POST',endpoint:'/contract-analysis',query:{},body:{contractText:'A'}};
const expected={network:'eip155:84532',payTo:'0x'+'a'.repeat(40),amountAtomic:500000,endpoint:'/contract-analysis'};
const settlement={success:true,finalized:true,transactionHash:'0x'+'b'.repeat(64),network:expected.network,payTo:expected.payTo,payer:'0x'+'c'.repeat(40),amountAtomic:500000};
test('trusted finalized settlement maps to digest-bound receipt',()=>{
 const receipt=adapt({settlement,request,expected});
 assert.equal(receipt.network,expected.network);
 assert.equal(receipt.endpoint,expected.endpoint);
 assert.match(receipt.requestDigest,/^[a-f0-9]{64}$/);
});
for (const [name,change] of [
 ['unfinalized',{finalized:false}],
 ['unsuccessful',{success:false}],
 ['wrong network',{network:'eip155:8453'}],
 ['wrong recipient',{payTo:'0x'+'d'.repeat(40)}],
 ['wrong amount',{amountAtomic:499999}],
 ['missing transaction',{transactionHash:null}],
 ['missing payer',{payer:null}]
]) test('reject '+name,()=>assert.throws(()=>adapt({settlement:{...settlement,...change},request,expected})));
test('reject endpoint mismatch',()=>assert.throws(()=>adapt({settlement,request:{...request,endpoint:'/enrich'},expected})));
test('does not claim to authenticate caller-supplied settlement objects',()=>{
 // This function is a shape-and-binding validator only. Never pass req.body or req.headers.
 assert.equal(typeof adapt,'function');
});
