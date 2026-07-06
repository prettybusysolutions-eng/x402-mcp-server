const assert = require('node:assert/strict');
const test = require('node:test');

const {
  airlockProofPacket,
  buildRevenueLoopStatus,
  buildDiscovery,
  isSafePublicUrl,
  revenueFrictionPreflight,
} = require('../server');

test('public URL guard rejects local and private targets', () => {
  assert.equal(isSafePublicUrl('http://127.0.0.1:8080/private'), false);
  assert.equal(isSafePublicUrl('http://169.254.169.254/latest/meta-data'), false);
  assert.equal(isSafePublicUrl('http://192.168.1.10'), false);
  assert.equal(isSafePublicUrl('https://example.com'), true);
});

test('preflight reports direct observations without inventing revenue', () => {
  const result = revenueFrictionPreflight({
    company: 'Example Co',
    pageText: 'Plans start at $49 per month. Get started. Contact us at sales@example.com.',
  });

  assert.equal(result.ok, true);
  assert.equal(result.evidenceQuality, 'buyer_supplied_public_text');
  assert.equal(result.verifiedRecoverableRevenueUsd, 0);
  assert.match(result.decisionBoundary, /not proof/i);
  assert.ok(result.observedSignals.some((item) => item.id === 'visible_pricing'));
  assert.ok(result.observedSignals.some((item) => item.id === 'purchase_cta'));
  assert.ok(result.observedSignals.some((item) => item.id === 'contact_path'));
});

test('preflight labels missing public signals as hypotheses', () => {
  const result = revenueFrictionPreflight({ pageText: 'Welcome to Example Co.' });

  assert.equal(result.ok, true);
  assert.ok(result.frictionFindings.some((item) => item.id === 'purchase_path_not_observed'));
  assert.ok(result.limitations.length >= 3);
  assert.equal(result.sources.length, 0);
});

test('x402 discovery exposes one 5 USDC preflight route', () => {
  const discovery = buildDiscovery('https://seller.example');
  const route = discovery.routes.find((item) => item.path === '/revenue-friction-preflight');

  assert.ok(route);
  assert.equal(route.pricing.price, '$5.00');
  assert.equal(route.pricing.network, 'eip155:84532');
  assert.equal(route.pricing.payTo, '0x75aAbC3D213fBC8482f0bA2aEc36ad184301B50a');
});

test('x402 discovery exposes 1 USDC machine-payer proof packet route', () => {
  const discovery = buildDiscovery('https://seller.example');
  const route = discovery.routes.find((item) => item.path === '/airlock-proof-packet');

  assert.ok(route);
  assert.equal(route.pricing.price, '$1.00');
  assert.equal(route.pricing.network, 'eip155:84532');
  assert.equal(route.pricing.payTo, '0x75aAbC3D213fBC8482f0bA2aEc36ad184301B50a');
  assert.equal(route.config.inputSchema.additionalProperties, false);
});

test('airlock proof packet stays public and truth-bound', () => {
  const result = airlockProofPacket({ buyerAgent: 'test-agent', purpose: 'first-dollar-check' });

  assert.equal(result.ok, true);
  assert.equal(result.endpoint, '/airlock-proof-packet');
  assert.equal(result.offerId, 'xzenia.airlock.machine-payer.usdc-1.v1');
  assert.equal(result.buyerAgent, 'test-agent');
  assert.equal(result.truthBoundary.selfPaymentCountsAsRevenue, false);
  assert.equal(result.truthBoundary.noSensitiveDataRequired, true);
  assert.match(result.artifact.humanUrl, /^https:\/\/prettybusysolutions-eng\.github\.io\//);
});

test('revenue loop counts only settled sales supplied by the ledger', () => {
  const empty = buildRevenueLoopStatus(0);
  assert.equal(empty.verified.grossRevenueUsdc, 0);
  assert.equal(empty.verified.remainingToFirstTargetUsdc, 100);
  assert.equal(empty.dailyTarget.requiredSettledSales, 20);
  assert.equal(empty.allocationPolicy.automaticWalletSpending, false);

  const firstTarget = buildRevenueLoopStatus(20);
  assert.equal(firstTarget.verified.grossRevenueUsdc, 100);
  assert.equal(firstTarget.verified.firstTargetComplete, true);
  assert.match(firstTarget.truthBoundary, /Self-payments/);
});
