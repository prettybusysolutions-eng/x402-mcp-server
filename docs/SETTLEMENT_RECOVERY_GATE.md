# Staging x402 settlement recovery integration gate

Status: DESIGN REVIEW ONLY. Do not merge PR #39 or release v1.0.2.

## Confirmed interface mismatch

Installed @x402/express 2.28.0 exposes onBeforeSettle/onAfterSettle.
The current facilitator-adapter expects transactionHash, finalized, payTo and
amountAtomic; the settlement result reported from the installed middleware
instead exposes transaction, network, payer and optional amount. **Do not
rename fields and call that verified settlement.** A settlement response alone
does not establish finality, asset, recipient, exact transfer amount, or
authorization-to-transaction correspondence.

## Proposed recovery protocol (not implemented)

1. Before settlement: obtain the fully buffered response from the actual hook
   context (verify this with a version-pinned integration test). Persist the
   response and a canonical, domain-separated authorization identity in a
   durable PREPARED record, together with expected chain, asset, recipient,
   atomic amount, payer and request digest. Commit before returning from the
   hook. If persistence fails, return {abort:true} explicitly.
2. Settlement: never perform a second charge on retry. Only a trusted server
   settlement result may advance the record. Handle ambiguous facilitator
   errors as UNKNOWN, not FAILED or unpaid.
3. After settlement: attach the transaction identity to the prepared record
   best-effort; callback exceptions must not be treated as durable guarantees.
4. Reconciliation: independently inspect chain transaction receipt, canonical
   USDC Transfer log(s), EIP-3009 authorization identity and expected payee,
   amount, asset, chain and finality policy. Nonce-used alone is insufficient
   proof of payment to the intended payee. A dropped facilitator response must
   not cause a second settlement.
5. Recovery: authenticate the payer using a fresh, expiring, one-time,
   domain-separated EIP-712 challenge (server origin, chain, contract, request
   digest, authorization identity, nonce, expiry). Bind the recovered payer to
   the independently verified on-chain authorization and stored PREPARED
   response. Rate-limit and atomically consume challenges. Never accept
   user-supplied transaction or signature as settlement evidence alone.
6. Only after independently verified settlement, return the persisted response
   without recomputation or recharge. If a prepared response is missing,
   reconcile to an explicit operator-visible exception rather than inventing
   or repeating an irreversible side effect.

## Test gates

- Fake facilitator verifies before/after-settle ordering and abort semantics.
- Fault injection: SQLite write failure before settlement must abort charging.
- Crash between facilitator success and post-settlement callback.
- Network timeout after chain settlement, then successful reconciliation.
- Invalid asset, payee, chain, amount, nonce, payer, signature and expiry.
- Multiple workers, duplicate authorization, different request digest.
- EIP-3009 only until Permit2 has an independent implementation and tests.
- Verify no wallet secrets, paid requests or production configuration required.

## Existing staging limitations

The current fulfillment_states table is not a PREPARED response store and
contains no payer or authorization nonce. The recovery-capability HMAC token
is insufficient when never delivered. The existing recovery endpoint is
disabled by default and must stay disabled until a complete recovery path is
tested. A successful unit suite is not proof of settlement safety.
