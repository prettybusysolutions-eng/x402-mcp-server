#!/usr/bin/env node

const baseUrl = (process.argv[2] || process.env.X402_PUBLIC_URL || 'http://127.0.0.1:8794').replace(/\/$/, '');
const expectedPath = '/airlock-proof-packet';
const expectedPrice = '$1.00';

async function fetchJson(url, options) {
  const response = await fetch(url, options);
  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { response, body };
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

const discoveryUrl = `${baseUrl}/.well-known/x402`;
const discovery = await fetchJson(discoveryUrl, { headers: { accept: 'application/json' } });

assert(discovery.response.ok, `Discovery failed: ${discovery.response.status}`);
assert(discovery.body && discovery.body.protocol === 'x402', 'Discovery body is not x402 protocol metadata');

const route = discovery.body.routes?.find((item) => item.path === expectedPath);
assert(route, `Missing ${expectedPath} in discovery`);
assert(route.pricing?.price === expectedPrice, `Expected ${expectedPrice}, got ${route.pricing?.price}`);
assert(route.pricing?.payTo, 'Missing payTo in route pricing');
assert(route.pricing?.network, 'Missing network in route pricing');

const unpaid = await fetchJson(`${baseUrl}${expectedPath}`, {
  method: 'POST',
  headers: {
    accept: 'application/json',
    'content-type': 'application/json',
  },
  body: JSON.stringify({
    buyerAgent: 'xzenia-readiness-verifier',
    purpose: 'unpaid challenge check only',
  }),
});

assert(unpaid.response.status === 402, `Expected unpaid POST to return 402, got ${unpaid.response.status}`);

console.log(JSON.stringify({
  ok: true,
  baseUrl,
  discoveryUrl,
  route: {
    path: route.path,
    method: route.method,
    price: route.pricing.price,
    network: route.pricing.network,
    payTo: route.pricing.payTo,
  },
  unpaidChallenge: {
    status: unpaid.response.status,
    hasBody: Boolean(unpaid.body),
  },
  boundary: {
    createdPaymentPayload: false,
    signedTransaction: false,
    spentFunds: false,
  },
}, null, 2));
