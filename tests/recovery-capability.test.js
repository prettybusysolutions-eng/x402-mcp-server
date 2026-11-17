'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const {issueRecoveryToken,verifyRecoveryToken}=require('../lib/recovery-capability');
const key=crypto.randomBytes(32);
const expected={settlementHash:'a'.repeat(64),requestDigest:'b'.repeat(64),network:'eip155:84532',endpoint:'/contract-analysis'};
test('valid recovery capability is scoped and expires',()=>{
 const expiresAt=Math.floor(Date.now()/1000)+60;
 const token=issueRecoveryToken({...expected,expiresAt},key);
 assert.equal(verifyRecoveryToken(token,expected,key,expiresAt-1),true);
 assert.equal(verifyRecoveryToken(token,expected,key,expiresAt),false);
 assert.equal(verifyRecoveryToken(token,{...expected,requestDigest:'c'.repeat(64)},key),false);
 assert.equal(verifyRecoveryToken(token,{...expected,network:'eip155:8453'},key),false);
 assert.equal(verifyRecoveryToken(token,{...expected,endpoint:'/enrich'},key),false);
 assert.equal(verifyRecoveryToken(token,expected,crypto.randomBytes(32)),false);
 assert.equal(verifyRecoveryToken(token.slice(0,-2)+'zz',expected,key),false);
});
test('refuses weak recovery signing key',()=>{
 assert.throws(()=>issueRecoveryToken({...expected,expiresAt:Math.floor(Date.now()/1000)+60},Buffer.alloc(8)));
});
