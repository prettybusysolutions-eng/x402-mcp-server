'use strict';
// STAGING ONLY. Adapts PreparedLedger to the installed @x402 2.28.0 settle hooks (issue #41).
// NOT wired into server.js. Contract, from the CI-verified lifecycle suite:
// - onBeforeSettle errors are swallowed and the charge proceeds, so every failure here is
//   caught and returned as {abort:true}. It never returns {skip:true}.
// - Abort fires no cancellation hook, so nothing else cleans up: we abort BEFORE any write
//   whenever possible, and the only write is the single atomic prepare().
// - onAfterSettle and onSettleFailure are best-effort; they never establish payment.
const { requestDigest } = require('./fulfillment-ledger');
const { authorizationId } = require('./prepared-ledger');

const OVERRIDES_HEADER = 'settlement-overrides';

function abort(reason, message) { return { abort: true, reason, message: String(message || reason).slice(0, 300) }; }

function eip3009Authorization(ctx) {
  const payload = ctx?.paymentPayload?.payload;
  const auth = payload?.authorization;
  if (!payload || payload.permit2Authorization !== undefined || !auth || typeof auth !== 'object') return null;
  const method = ctx?.requirements?.extra?.assetTransferMethod;
  if (method !== undefined && method !== 'eip3009') return null;
  return auth;
}

function idFromContext(ctx) {
  const auth = eip3009Authorization(ctx);
  if (!auth) throw new Error('not an EIP-3009 authorization');
  return authorizationId({ network: ctx.requirements.network, asset: ctx.requirements.asset, payer: auth.from, nonce: auth.nonce });
}

function plain(value) {
  // Express 5 query objects have a null prototype; canonical() accepts only plain objects.
  if (Array.isArray(value)) return value.map(plain);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, plain(v)]));
  return value;
}

function createPreparedSettlementHooks({ ledger, log = () => {} }) {
  if (!ledger || typeof ledger.prepare !== 'function') throw new Error('ledger required');

  async function onBeforeSettle(ctx) {
    try {
      if (ctx?.phase !== 'after-handler') return abort('unsupported_phase', 'only the after-handler authorization flow is supported');
      const req = ctx.requirements || {};
      if (req.scheme !== 'exact') return abort('unsupported_scheme');
      const auth = eip3009Authorization(ctx);
      if (!auth) return abort('unsupported_payment_method', 'EIP-3009 only');
      const t = ctx.transportContext || {};
      const body = t.responseBody;
      if (!Buffer.isBuffer(body) || body.length === 0) return abort('missing_response_body');
      const headers = t.responseHeaders || {};
      if (Object.keys(headers).some(k => k.toLowerCase() === OVERRIDES_HEADER)) return abort('settlement_override_unsupported');
      if (String(auth.value) !== String(req.amount)) return abort('amount_mismatch', 'authorized value differs from settlement amount');
      if (String(auth.to).toLowerCase() !== String(req.payTo).toLowerCase()) return abort('payee_mismatch');
      const adapter = t.request?.adapter;
      if (!adapter) return abort('missing_request_context');
      const method = String(t.request.method || adapter.getMethod()).toUpperCase();
      const endpoint = adapter.getPath();
      const digest = requestDigest({ method, endpoint, query: plain(adapter.getQueryParams() || {}), body: plain(adapter.getBody() ?? {}) });
      const { outcome } = ledger.prepare({
        network: req.network, asset: req.asset, payTo: req.payTo, payer: auth.from, amountAtomic: req.amount,
        nonce: auth.nonce, validBefore: Number(auth.validBefore), endpoint, requestDigest: digest,
      }, body);
      if (outcome === 'inserted') return undefined;
      return abort(outcome === 'duplicate' ? 'duplicate_authorization' : 'authorization_conflict');
    } catch (error) {
      log('prepare_failed', error);
      return abort('prepare_failed', error?.message || error);
    }
  }

  async function onAfterSettle(ctx) {
    try { ledger.markFacilitatorSettled(idFromContext(ctx), ctx.result); }
    catch (error) { log('after_settle_record_failed', error); }
  }

  async function onSettleFailure(ctx) {
    try { ledger.markUnknown(idFromContext(ctx), 'facilitator: ' + (ctx?.error?.message || 'settlement failed')); }
    catch (error) { log('settle_failure_record_failed', error); }
    return undefined; // never claims recovery
  }

  return { onBeforeSettle, onAfterSettle, onSettleFailure };
}

function registerPreparedSettlementHooks(resourceServer, options) {
  const hooks = createPreparedSettlementHooks(options);
  resourceServer.onBeforeSettle(hooks.onBeforeSettle).onAfterSettle(hooks.onAfterSettle).onSettleFailure(hooks.onSettleFailure);
  return hooks;
}

module.exports = { createPreparedSettlementHooks, registerPreparedSettlementHooks };
