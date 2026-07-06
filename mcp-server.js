#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { z } = require('zod');
const { x402Client } = require('@x402/core/client');
const { x402HTTPClient } = require('@x402/core/http');
const { registerExactEvmScheme } = require('@x402/evm/exact/client');
const { privateKeyToAccount } = require('viem/accounts');
const { createPublicClient, http, erc20Abi, formatUnits } = require('viem');

const ROOT = __dirname;
const ENV_FILE = process.env.X402_ENV_FILE || path.join(ROOT, '.env');
const DEFAULT_KEY_FILE = process.env.X402_PAYER_KEY_FILE || '/Users/marcuscoarchitect/.openclaw/workspace/private/x402-selfpay-payer.key';
const PUBLIC_URL_FILE = process.env.X402_PUBLIC_URL_FILE || '/tmp/x402-public-url.txt';
const BASE_RPC_URL = process.env.BASE_RPC_URL || 'https://mainnet.base.org';
const BASE_USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const DEFAULT_BASE_URL = process.env.X402_PUBLIC_URL || process.env.X402_BASE_URL || 'http://127.0.0.1:8794';

const ENDPOINTS = {
  enrich: { path: '/enrich', minUsdc: 0.05 },
  market_intel: { path: '/market-intel', minUsdc: 0.10 },
  contract_analysis: { path: '/contract-analysis', minUsdc: 0.50 },
  airlock_proof_packet: { path: '/airlock-proof-packet', minUsdc: 1.00 },
};

function loadEnvFile(filePath) {
  try {
    const text = fs.readFileSync(filePath, 'utf8');
    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#') || !line.includes('=')) continue;
      const idx = line.indexOf('=');
      const key = line.slice(0, idx).trim();
      const value = line.slice(idx + 1).trim();
      if (key && !(key in process.env)) process.env[key] = value;
    }
  } catch {}
}

function normalizePrivateKey(raw, sourceLabel) {
  const match = String(raw || '').trim().match(/(0x[a-fA-F0-9]{64}|[a-fA-F0-9]{64})/);
  if (!match) throw new Error(`Could not parse a 32-byte hex private key from ${sourceLabel}`);
  return match[1].startsWith('0x') ? match[1] : `0x${match[1]}`;
}

function readPrivateKey(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8').trim();
  return normalizePrivateKey(raw, filePath);
}

function readPublicUrl() {
  try {
    const url = fs.readFileSync(PUBLIC_URL_FILE, 'utf8').trim();
    return url || null;
  } catch {
    return null;
  }
}

function getBaseUrl() {
  return process.env.X402_PUBLIC_URL || readPublicUrl() || DEFAULT_BASE_URL;
}

async function buildRuntime() {
  loadEnvFile(ENV_FILE);
  const network = process.env.X402_NETWORK || 'eip155:8453';
  if (network !== 'eip155:8453') throw new Error(`Expected eip155:8453, got ${network}`);
  if (!process.env.CDP_API_KEY_ID || !process.env.CDP_API_KEY_SECRET) {
    throw new Error('CDP auth is missing in .env');
  }
  const privateKey = process.env.BASE_MAINNET_PAYER_KEY
    ? normalizePrivateKey(process.env.BASE_MAINNET_PAYER_KEY, 'BASE_MAINNET_PAYER_KEY')
    : readPrivateKey(DEFAULT_KEY_FILE);
  const account = privateKeyToAccount(privateKey);
  const publicClient = createPublicClient({ transport: http(BASE_RPC_URL) });
  const client = new x402Client();
  registerExactEvmScheme(client, {
    signer: account,
    networks: ['eip155:8453'],
    schemeOptions: { 8453: { rpcUrl: BASE_RPC_URL } },
  });
  const httpClient = new x402HTTPClient(client);
  return { network, account, publicClient, httpClient };
}

async function getUsdcBalance(publicClient, address) {
  const balance = await publicClient.readContract({
    address: BASE_USDC,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [address],
  });
  return Number(formatUnits(balance, 6));
}

async function callPaidEndpoint(toolName, payload) {
  const endpoint = ENDPOINTS[toolName];
  if (!endpoint) throw new Error(`Unknown tool ${toolName}`);
  const runtime = await buildRuntime();
  const balance = await getUsdcBalance(runtime.publicClient, runtime.account.address);
  if (balance < endpoint.minUsdc) {
    throw new Error(`Need at least ${endpoint.minUsdc.toFixed(2)} USDC on Base for ${toolName}; current balance ${balance.toFixed(6)} USDC.`);
  }
  const baseUrl = getBaseUrl();
  const apiUrl = `${baseUrl}${endpoint.path}`;

  const first = await fetch(apiUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(payload || {}),
  });

  if (first.status !== 402) {
    const body = await first.text();
    throw new Error(`Expected 402 challenge from ${apiUrl}, got ${first.status}: ${body.slice(0, 400)}`);
  }

  const paymentRequired = runtime.httpClient.getPaymentRequiredResponse((name) => first.headers.get(name));
  const paymentPayload = await runtime.httpClient.createPaymentPayload(paymentRequired);

  const bazaarInfo = paymentPayload.extensions?.bazaar?.info?.input;
  if (bazaarInfo && bazaarInfo.type === 'http' && bazaarInfo.method === 'POST' && bazaarInfo.bodyType === 'json') {
    bazaarInfo.body = payload || {};
  }

  const paymentHeaders = runtime.httpClient.encodePaymentSignatureHeader(paymentPayload);
  const paid = await fetch(apiUrl, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json',
      ...paymentHeaders,
    },
    body: JSON.stringify(payload || {}),
  });

  const result = await runtime.httpClient.processResponse(paid);
  if (result.kind !== 'success') {
    const body = 'body' in result ? result.body : null;
    throw new Error(`Payment attempt did not settle successfully: ${result.kind} ${JSON.stringify(body).slice(0, 500)}`);
  }

  return {
    tool: toolName,
    apiUrl,
    network: result.settleResponse.network,
    transaction: result.settleResponse.transaction,
    payerAddress: runtime.account.address,
    remainingUsdcBalance: await getUsdcBalance(runtime.publicClient, runtime.account.address),
    body: result.body,
  };
}

function asToolResult(data) {
  return {
    content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
    structuredContent: data,
  };
}

async function main() {
  const server = new McpServer({ name: 'xzenia-x402', version: '0.1.0' });

  server.registerTool(
    'x402_metadata',
    {
      title: 'x402 metadata',
      description: 'Return the active Xzenia public discovery, OpenAPI, llms, and payment metadata.',
    },
    async () => {
      const baseUrl = getBaseUrl();
      return asToolResult({
        baseUrl,
        discoveryUrl: `${baseUrl}/.well-known/x402`,
        openapiUrl: `${baseUrl}/openapi.json`,
        llmsUrl: `${baseUrl}/llms.txt`,
        aiPluginUrl: `${baseUrl}/.well-known/ai-plugin.json`,
        prices: {
          enrich: '$0.05',
          market_intel: '$0.10',
          contract_analysis: '$0.50',
          airlock_proof_packet: '$1.00',
        },
        note: 'Paid tool calls spend real USDC on Base via x402 exact.'
      });
    }
  );

  server.registerTool(
    'enrich',
    {
      title: 'Company/domain enrichment',
      description: 'Pay the live x402 /enrich endpoint and return the JSON result.',
      inputSchema: {
        company: z.string().optional(),
        domain: z.string().optional(),
        website: z.string().optional(),
      },
    },
    async (args) => asToolResult(await callPaidEndpoint('enrich', args))
  );

  server.registerTool(
    'market_intel',
    {
      title: 'Market intelligence',
      description: 'Pay the live x402 /market-intel endpoint and return the JSON result.',
      inputSchema: {
        company: z.string().optional(),
        sector: z.string().optional(),
        geo: z.string().optional(),
      },
    },
    async (args) => asToolResult(await callPaidEndpoint('market_intel', args))
  );

  server.registerTool(
    'airlock_proof_packet',
    {
      title: 'Airlock proof packet',
      description: 'Pay the live x402 /airlock-proof-packet endpoint and return the public proof packet.',
      inputSchema: {
        buyerAgent: z.string().optional(),
        purpose: z.string().optional(),
      },
    },
    async (args) => asToolResult(await callPaidEndpoint('airlock_proof_packet', args))
  );

  server.registerTool(
    'contract_analysis',
    {
      title: 'Contract analysis',
      description: 'Pay the live x402 /contract-analysis endpoint and return the JSON result.',
      inputSchema: {
        company: z.string().optional(),
        contractText: z.string().optional(),
        contractsText: z.string().optional(),
        contractUrl: z.string().optional(),
      },
    },
    async (args) => asToolResult(await callPaidEndpoint('contract_analysis', args))
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exit(1);
});
