'use strict';
// Staging-only recovery capability. This module does not bypass payment middleware.
// Token creation must occur only AFTER a trusted settlement is bound to a request.
// Protect the signing key with a secret manager; never expose it in URLs or logs.
const crypto=require('node:crypto');
function validateKey(key) {
  if (!Buffer.isBuffer(key) || key.length<32) throw Error('32-byte recovery signing key required');
}
function issueRecoveryToken({settlementHash,requestDigest,network,endpoint,expiresAt},key) {
  validateKey(key);
  if (!/^(0x)?[a-fA-F0-9]{64}$/.test(settlementHash||'') || !/^[a-fA-F0-9]{64}$/.test(requestDigest||''))
    throw Error('invalid recovery binding');
  if (!/^eip155:\d+$/.test(network||'') || !/^\/[a-z0-9/-]+$/.test(endpoint||''))
    throw Error('invalid recovery scope');
  if (!Number.isSafeInteger(expiresAt) || expiresAt<=Math.floor(Date.now()/1000))
    throw Error('invalid expiration');
  const payload=Buffer.from(JSON.stringify({v:1,h:settlementHash.toLowerCase(),d:requestDigest.toLowerCase(),n:network,e:endpoint,x:expiresAt})).toString('base64url');
  const mac=crypto.createHmac('sha256',key).update(payload).digest('base64url');
  return payload+'.'+mac;
}
function verifyRecoveryToken(token,expected,key,now=Math.floor(Date.now()/1000)) {
  validateKey(key);
  if (typeof token!=='string' || token.length>2048 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token))
    return false;
  const [payload,mac]=token.split('.');
  const actual=crypto.createHmac('sha256',key).update(payload).digest();
  const supplied=Buffer.from(mac,'base64url');
  if (actual.length!==supplied.length || !crypto.timingSafeEqual(actual,supplied)) return false;
  let data;
  try { data=JSON.parse(Buffer.from(payload,'base64url').toString('utf8')); }
  catch { return false; }
  return data.v===1 && Number.isSafeInteger(data.x) && now<data.x &&
    data.h===expected.settlementHash?.toLowerCase() &&
    data.d===expected.requestDigest?.toLowerCase() &&
    data.n===expected.network && data.e===expected.endpoint;
}
module.exports={issueRecoveryToken,verifyRecoveryToken};
