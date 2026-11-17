'use strict';
// Staging recovery controller. Never accepts a client-supplied settlement as verified.
// Requires a durable FULFILLED ledger record and a matching signed capability.
const {verifyRecoveryToken}=require('./recovery-capability');
function createRecoveryHandler({ledger,key,network}) {
 if (!ledger || typeof ledger.get!=='function') throw Error('ledger required');
 if (!Buffer.isBuffer(key) || key.length<32) throw Error('recovery signing key required');
 if (!/^eip155:\d+$/.test(network||'')) throw Error('network required');
 return (req,res)=>{
  res.set('Cache-Control','no-store');
  res.set('Pragma','no-cache');
  const token=req.get('X-Recovery-Token');
  const hash=req.body && req.body.settlementHash;
  if (typeof token!=='string' || typeof hash!=='string' || !/^(0x)?[a-fA-F0-9]{64}$/.test(hash))
   return res.status(401).json({ok:false,error:'Unauthorized'});
  let row;
  try {row=ledger.get(hash);}
  catch {return res.status(503).json({ok:false,error:'Recovery unavailable'});}
  // Identical 401 for missing rows, wrong scopes and forged capabilities.
  if (!row || row.network!==network ||
      !verifyRecoveryToken(token,{settlementHash:row.settlementHash,requestDigest:row.requestDigest,network:row.network,endpoint:row.endpoint},key))
   return res.status(401).json({ok:false,error:'Unauthorized'});
  if (row.state!=='FULFILLED') return res.status(202).json({ok:false,state:'PENDING_RECONCILIATION'});
  if (typeof row.response!=='string') return res.status(503).json({ok:false,error:'Recovery unavailable'});
  try {return res.status(200).type('application/json').send(row.response);}
  catch {return res.status(503).json({ok:false,error:'Recovery unavailable'});}
 };
}
module.exports={createRecoveryHandler};
