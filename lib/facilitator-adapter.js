'use strict';
// Pure validation boundary, NOT a proof of settlement. The caller must authenticate
// the facilitator response and independently establish finality before invoking this.
const {requestDigest}=require('./fulfillment-ledger');
const NETWORKS=new Set(['eip155:8453','eip155:84532']);
function verifiedReceiptFromTrustedSettlement({settlement, request, expected}) {
  if (!settlement || settlement.success !== true || settlement.finalized !== true)
    throw Error('trusted finalized settlement required');
  if (!expected || !NETWORKS.has(expected.network) || !/^0x[a-fA-F0-9]{40}$/.test(expected.payTo||''))
    throw Error('invalid configured settlement expectation');
  const h=settlement.transactionHash;
  if (!/^(0x)?[a-fA-F0-9]{64}$/.test(h||'')) throw Error('missing transaction hash');
  if (settlement.network!==expected.network) throw Error('network mismatch');
  if (typeof settlement.payTo!=='string' || settlement.payTo.toLowerCase()!==expected.payTo.toLowerCase())
    throw Error('recipient mismatch');
  if (typeof settlement.payer!=='string' || !/^0x[a-fA-F0-9]{40}$/.test(settlement.payer))
    throw Error('missing payer');
  if (!Number.isSafeInteger(settlement.amountAtomic) || settlement.amountAtomic!==expected.amountAtomic)
    throw Error('amount mismatch');
  if (!request || request.endpoint!==expected.endpoint) throw Error('endpoint mismatch');
  return Object.freeze({
    settlementHash:h.toLowerCase(),
    network:settlement.network,
    endpoint:request.endpoint,
    requestDigest:requestDigest(request),
    payer:settlement.payer.toLowerCase(),
  });
}
module.exports={verifiedReceiptFromTrustedSettlement};
