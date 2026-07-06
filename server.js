const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const express = require('express');
const { paymentMiddleware, x402ResourceServer } = require('@x402/express');
const { HTTPFacilitatorClient } = require('@x402/core/server');
const { decodePaymentSignatureHeader, decodePaymentResponseHeader } = require('@x402/core/http');
const { ExactEvmScheme } = require('@x402/evm/exact/server');
const { declareDiscoveryExtension, bazaarResourceServerExtension } = require('@x402/extensions');
let generateJwt = null;
try {
  ({ generateJwt } = require('@coinbase/cdp-sdk/auth'));
} catch {
  // optional; only needed for CDP-backed mainnet auth
}

const ROOT = __dirname;
const WORKSPACE = path.resolve(ROOT, '..', '..');
const SEARCH_SH = process.env.SEARCH_SH || path.join(WORKSPACE, 'main', 'skills', 'prospect-engine', 'search.sh');
const ENV_FILE = process.env.X402_ENV_FILE || path.join(ROOT, '.env');

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
  } catch {
    // optional
  }
}

loadEnvFile(ENV_FILE);

const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.PORT || 8794);
const PUBLIC_URL_FILE = process.env.X402_PUBLIC_URL_FILE || '/tmp/x402-public-url.txt';
const SERVICE_NAME = 'x402-enrichment-api';
const WALLET_ADDRESS = process.env.X402_PAY_TO || process.env.WALLET_ADDRESS || '0x75aAbC3D213fBC8482f0bA2aEc36ad184301B50a';
const FACILITATOR_URL = process.env.X402_FACILITATOR_URL || 'https://x402.org/facilitator';
const NETWORK = process.env.X402_NETWORK || 'eip155:84532';
const IS_MAINNET = NETWORK === 'eip155:8453';
const CDP_HOST = 'api.cdp.coinbase.com';
const REQUEST_LOG_DB = process.env.X402_REQUEST_LOG_DB || path.join(ROOT, 'x402-requests.sqlite3');
const PREFLIGHT_PRICE_USDC = 5;
const FIRST_REVENUE_TARGET_USDC = 100;
const DAILY_REVENUE_TARGET_USDC = 100;

const ROUTES = [
  {
    method: 'POST',
    path: '/enrich',
    price: '$0.05',
    description: 'Company domain enrichment',
    config: {
      description: 'Company domain enrichment',
      inputSchema: {
        type: 'object',
        properties: {
          company: { type: 'string', description: 'Company name' },
          domain: { type: 'string', description: 'Company domain' },
          website: { type: 'string', description: 'Website URL' },
        },
        additionalProperties: true,
      },
      outputSchema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          company: { type: 'object' },
          website: { type: 'object' },
          searchResults: { type: 'array' },
          sources: { type: 'array' },
        },
      },
    },
  },
  {
    method: 'POST',
    path: '/market-intel',
    price: '$0.10',
    description: 'Industry plus geography intelligence',
    config: {
      description: 'Industry plus geography intelligence',
      inputSchema: {
        type: 'object',
        properties: {
          sector: { type: 'string', description: 'Industry sector' },
          geo: { type: 'string', description: 'Geography / market' },
          company: { type: 'string', description: 'Optional anchor company' },
        },
        additionalProperties: true,
      },
      outputSchema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          market: { type: 'object' },
          targets: { type: 'array' },
          searchResults: { type: 'array' },
        },
      },
    },
  },
  {
    method: 'POST',
    path: '/contract-analysis',
    price: '$0.50',
    description: 'Contract term extraction and leakage risk',
    config: {
      description: 'Contract term extraction and leakage risk',
      inputSchema: {
        type: 'object',
        properties: {
          contractsText: { type: 'string', description: 'Full contract text' },
          contractText: { type: 'string', description: 'Full contract text' },
          contractUrl: { type: 'string', description: 'Contract text URL' },
          company: { type: 'string', description: 'Contract counterparty' },
        },
        additionalProperties: true,
      },
      outputSchema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          riskScore: { type: 'number' },
          terms: { type: 'array' },
          redFlags: { type: 'array' },
          summary: { type: 'string' },
        },
      },
    },
  },
  {
    method: 'POST',
    path: '/airlock-proof-packet',
    price: '$1.00',
    description: 'Xzenia Airlock proof-bound autonomous labor packet',
    config: {
      description: 'Return the public proof packet for proof-bound autonomous labor after exact x402 settlement',
      inputSchema: {
        type: 'object',
        properties: {
          buyerAgent: { type: 'string', description: 'Optional calling agent or client name' },
          purpose: { type: 'string', description: 'Optional reason for retrieving the packet' },
        },
        additionalProperties: false,
      },
      outputSchema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          endpoint: { type: 'string' },
          offerId: { type: 'string' },
          artifact: { type: 'object' },
          truthBoundary: { type: 'object' },
        },
      },
    },
  },
  {
    method: 'POST',
    path: '/revenue-friction-preflight',
    price: '$5.00',
    description: 'Evidence-bound public website revenue-friction preflight',
    config: {
      description: 'Inspect public website signals that may create purchase friction without claiming recovered revenue',
      inputSchema: {
        type: 'object',
        properties: {
          company: { type: 'string', description: 'Company name' },
          website: { type: 'string', description: 'Public website URL' },
          domain: { type: 'string', description: 'Public website domain' },
          pageText: { type: 'string', description: 'Optional buyer-supplied public page text' },
        },
        anyOf: [
          { required: ['website'] },
          { required: ['domain'] },
          { required: ['pageText'] },
        ],
        additionalProperties: false,
      },
      outputSchema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          evidenceQuality: { type: 'string' },
          observedSignals: { type: 'array' },
          frictionFindings: { type: 'array' },
          verifiedRecoverableRevenueUsd: { type: 'number' },
          limitations: { type: 'array' },
        },
      },
    },
  },
];

function readPublicUrl() {
  try {
    const value = fs.readFileSync(PUBLIC_URL_FILE, 'utf8').trim();
    return value || null;
  } catch {
    return null;
  }
}

function safeSql(value) {
  if (value === null || value === undefined) return 'NULL';
  return `'${String(value).replace(/'/g, "''")}'`;
}

function ensureRequestLogDb() {
  run('sqlite3', [REQUEST_LOG_DB, `
    CREATE TABLE IF NOT EXISTS request_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts TEXT NOT NULL,
      method TEXT,
      endpoint TEXT,
      status_code INTEGER,
      has_payment INTEGER,
      payer_address TEXT,
      settlement_tx_hash TEXT,
      remote_addr TEXT,
      user_agent TEXT,
      request_body TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_request_log_ts ON request_log(ts);
    CREATE INDEX IF NOT EXISTS idx_request_log_endpoint ON request_log(endpoint);
    CREATE INDEX IF NOT EXISTS idx_request_log_payer ON request_log(payer_address);
    CREATE INDEX IF NOT EXISTS idx_request_log_tx ON request_log(settlement_tx_hash);
  `]);
}

function extractPayerFromPaymentHeader(header) {
  if (!header) return null;
  try {
    const decoded = decodePaymentSignatureHeader(header);
    return decoded?.payload?.authorization?.from || decoded?.payload?.permit2Authorization?.from || null;
  } catch {
    return null;
  }
}

function extractSettlementTxFromResponseHeader(headerValue) {
  if (!headerValue) return null;
  try {
    const decoded = decodePaymentResponseHeader(String(headerValue));
    return decoded?.transaction || null;
  } catch {
    return null;
  }
}

function insertRequestLog(fields) {
  try {
    const sql = `INSERT INTO request_log (ts, method, endpoint, status_code, has_payment, payer_address, settlement_tx_hash, remote_addr, user_agent, request_body)
      VALUES (
        ${safeSql(fields.ts)},
        ${safeSql(fields.method)},
        ${safeSql(fields.endpoint)},
        ${Number.isFinite(fields.statusCode) ? fields.statusCode : 'NULL'},
        ${fields.hasPayment ? 1 : 0},
        ${safeSql(fields.payerAddress)},
        ${safeSql(fields.settlementTxHash)},
        ${safeSql(fields.remoteAddr)},
        ${safeSql(fields.userAgent)},
        ${safeSql(fields.requestBody)}
      );`;
    execFileSync('sqlite3', [REQUEST_LOG_DB, sql], { encoding: 'utf8', timeout: 8000 });
  } catch (error) {
    console.warn('request log write failed:', error?.message || error);
  }
}

function settledPreflightSales() {
  try {
    const value = run('sqlite3', [
      REQUEST_LOG_DB,
      `SELECT COUNT(DISTINCT settlement_tx_hash)
       FROM request_log
       WHERE endpoint = '/revenue-friction-preflight'
         AND status_code BETWEEN 200 AND 299
         AND settlement_tx_hash IS NOT NULL
         AND settlement_tx_hash != '';`,
    ]);
    return Number(value) || 0;
  } catch {
    return 0;
  }
}

function buildRevenueLoopStatus(settledSales = 0) {
  const verifiedGrossUsdc = settledSales * PREFLIGHT_PRICE_USDC;
  const salesPerTarget = Math.ceil(DAILY_REVENUE_TARGET_USDC / PREFLIGHT_PRICE_USDC);
  return {
    ok: true,
    product: {
      endpoint: '/revenue-friction-preflight',
      unitPriceUsdc: PREFLIGHT_PRICE_USDC,
      fulfillment: 'automatic_after_verified_x402_settlement',
      marginalWalletSpendUsdc: 0,
    },
    verified: {
      uniqueSettledSales: settledSales,
      grossRevenueUsdc: verifiedGrossUsdc,
      firstTargetUsdc: FIRST_REVENUE_TARGET_USDC,
      remainingToFirstTargetUsdc: Math.max(0, FIRST_REVENUE_TARGET_USDC - verifiedGrossUsdc),
      firstTargetComplete: verifiedGrossUsdc >= FIRST_REVENUE_TARGET_USDC,
    },
    dailyTarget: {
      grossRevenueUsdc: DAILY_REVENUE_TARGET_USDC,
      requiredSettledSales: salesPerTarget,
      status: 'target_not_guarantee',
    },
    allocationPolicy: {
      walletReservePercent: 80,
      reinvestmentReservePercent: 20,
      automaticWalletSpending: false,
      note: 'Reinvestment is reserved in the ledger and requires a separately approved external spend.',
    },
    closedLoop: [
      'A buyer or authorized agent discovers the paid resource.',
      'The buyer settles exactly 5 USDC on Base through x402.',
      'The service fulfills one evidence-bound report automatically.',
      'The unique settlement transaction is recorded as verified gross revenue.',
      'Eighty percent remains wallet reserve; twenty percent becomes an approval-gated reinvestment reserve.',
      'Capacity and discovery improve only from settled external revenue.',
    ],
    truthBoundary: 'Self-payments, failed settlements, duplicate transaction hashes, and unpaid requests do not count as revenue.',
  };
}

function createRequestLogger() {
  return (req, res, next) => {
    req.requestLogContext = {
      ts: new Date().toISOString(),
      method: req.method,
      endpoint: req.path,
      hasPayment: Boolean(req.get('payment-signature') || req.get('x-payment')),
      payerAddress: extractPayerFromPaymentHeader(req.get('payment-signature') || req.get('x-payment') || null),
      remoteAddr: req.ip || req.socket?.remoteAddress || null,
      userAgent: req.get('user-agent') || null,
      requestBody: req.body && Object.keys(req.body).length ? JSON.stringify(req.body).slice(0, 4000) : null,
    };
    next();
  };
}

function flushRequestLog(req, res, extra = {}) {
  const ctx = req.requestLogContext || {
    ts: new Date().toISOString(),
    method: req.method,
    endpoint: req.path,
  };
  insertRequestLog({
    ...ctx,
    statusCode: extra.statusCode ?? res.statusCode,
    hasPayment: extra.hasPayment ?? ctx.hasPayment,
    payerAddress: extra.payerAddress ?? ctx.payerAddress,
    settlementTxHash: extra.settlementTxHash ?? extractSettlementTxFromResponseHeader(res.getHeader('PAYMENT-RESPONSE')),
    requestBody: extra.requestBody ?? ctx.requestBody,
  });
}

function run(command, args, opts = {}) {
  return execFileSync(command, args, {
    encoding: 'utf8',
    maxBuffer: 2 * 1024 * 1024,
    timeout: opts.timeout || 15000,
    ...opts,
  }).trim();
}

function runSearch(query, limit = 5) {
  if (!fs.existsSync(SEARCH_SH)) return [];
  try {
    const out = run('bash', [SEARCH_SH, query], { timeout: 12000 });
    return out
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(0, limit);
  } catch {
    return [];
  }
}

function fetchUrl(url) {
  if (!isSafePublicUrl(url)) return '';
  try {
    return run('curl', [
      '-LfsS',
      '--max-time', '12',
      '--max-redirs', '4',
      '--proto', '=http,https',
      '--proto-redir', '=http,https',
      '-A', 'Mozilla/5.0',
      url,
    ], { timeout: 14000 });
  } catch {
    return '';
  }
}

function isSafePublicUrl(value) {
  try {
    const parsed = new URL(value);
    if (!['http:', 'https:'].includes(parsed.protocol)) return false;
    if (parsed.username || parsed.password) return false;
    const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return false;
    if (host === '::1' || host === '0.0.0.0') return false;
    if (/^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host)) return false;
    const match172 = host.match(/^172\.(\d+)\./);
    if (match172 && Number(match172[1]) >= 16 && Number(match172[1]) <= 31) return false;
    if (/^169\.254\./.test(host)) return false;
    return true;
  } catch {
    return false;
  }
}

function extractTitle(html) {
  const match = html.match(/<title[^>]*>([^<]{1,200})<\/title>/i);
  return match ? match[1].trim() : null;
}

function extractMetaDescription(html) {
  const match = html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']{1,500})["']/i);
  return match ? match[1].trim() : null;
}

function extractHeadings(html) {
  const headings = [];
  for (const tag of ['h1', 'h2', 'h3']) {
    const re = new RegExp(`<${tag}[^>]*>([^<]{1,120})<\\/${tag}>`, 'ig');
    let m;
    while ((m = re.exec(html)) && headings.length < 8) {
      headings.push(m[1].trim());
    }
  }
  return headings.slice(0, 8);
}

function stripTags(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/ig, ' ')
    .replace(/<style[\s\S]*?<\/style>/ig, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractEmails(text) {
  return Array.from(new Set((String(text || '').match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/ig) || []))).slice(0, 10);
}

function extractPhones(text) {
  const matches = String(text || '').match(/(?:\+?1[\s.-]?)?(?:\(?\d{3}\)?[\s.-]?)\d{3}[\s.-]?\d{4}/g) || [];
  return Array.from(new Set(matches.map((x) => x.trim()))).slice(0, 10);
}

function extractJsonLdOrganizations(html) {
  const out = [];
  const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/ig;
  let m;
  while ((m = re.exec(String(html || ''))) && out.length < 5) {
    try {
      const parsed = JSON.parse(m[1].trim());
      const list = Array.isArray(parsed) ? parsed : [parsed];
      for (const item of list) {
        if (!item || typeof item !== 'object') continue;
        const type = Array.isArray(item['@type']) ? item['@type'].join(',') : String(item['@type'] || '');
        if (!/organization|corporation|localbusiness|softwareapplication|webpage|website/i.test(type)) continue;
        out.push({
          type: type || null,
          name: item.name || null,
          description: item.description || null,
          url: item.url || null,
          sameAs: Array.isArray(item.sameAs) ? item.sameAs.slice(0, 8) : [],
        });
        if (out.length >= 5) break;
      }
    } catch {
      // ignore malformed json-ld
    }
  }
  return out;
}

function normalizeUrl(value) {
  if (!value) return null;
  if (/^https?:\/\//i.test(value)) return value;
  return `https://${value.replace(/^\/\//, '').replace(/^https?:\/\//i, '')}`;
}

function deriveDomain(company, website, domain) {
  if (domain) return domain.replace(/^https?:\/\//i, '').replace(/^www\./i, '').replace(/\/.*/, '');
  if (website) {
    try {
      return new URL(normalizeUrl(website)).hostname.replace(/^www\./i, '');
    } catch {
      return null;
    }
  }
  if (!company) return null;
  const slug = company.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(/\s+/)[0];
  return slug ? `${slug}.com` : null;
}

function parseSearchResults(lines) {
  return lines.map((url, index) => ({ rank: index + 1, url, title: null, snippet: null }));
}

function enrichCompany(payload = {}) {
  const company = payload.company || payload.name || null;
  const website = normalizeUrl(payload.website || payload.url || null);
  const domain = deriveDomain(company, website, payload.domain || null);
  const queries = [];
  if (company && domain) queries.push(`${company} ${domain}`);
  if (company) queries.push(`${company} company profile OR about OR services`);
  if (domain) queries.push(`site:${domain} ${company || domain}`);
  const searchResults = [];
  for (const query of queries.slice(0, 4)) {
    for (const url of runSearch(query, 5)) searchResults.push({ query, url });
  }
  const uniqueSources = [];
  const seen = new Set();
  for (const item of searchResults) {
    if (seen.has(item.url)) continue;
    seen.add(item.url);
    uniqueSources.push(item);
  }

  const homepageCandidates = [];
  if (website) homepageCandidates.push(website);
  if (domain) {
    homepageCandidates.push(`https://${domain}`);
    homepageCandidates.push(`http://${domain}`);
  }

  let homepage = null;
  let homepageHtml = '';
  for (const url of homepageCandidates) {
    const html = fetchUrl(url);
    if (!html) continue;
    homepageHtml = html;
    homepage = {
      url,
      title: extractTitle(html),
      description: extractMetaDescription(html),
      headings: extractHeadings(html),
      preview: html.replace(/\s+/g, ' ').slice(0, 1200),
    };
    if (homepage.title || homepage.description) break;
  }

  const homepageText = stripTags(homepageHtml);
  const orgProfiles = extractJsonLdOrganizations(homepageHtml);
  const emails = extractEmails(homepageText);
  const phones = extractPhones(homepageText);

  const social = Array.from(new Set((homepageHtml.match(/https?:\/\/[^"'\s>]+/g) || [])
    .filter((u) => /linkedin\.com|twitter\.com|x\.com|facebook\.com|youtube\.com|instagram\.com/i.test(u))));
  const techSignals = [];
  const techChecks = [
    ['React', /react/i],
    ['Next.js', /next\.js|__next/i],
    ['AWS', /amazonaws|aws/i],
    ['Stripe', /stripe/i],
    ['Cloudflare', /cloudflare/i],
    ['WordPress', /wp-content|wordpress/i],
    ['Shopify', /shopify/i],
    ['Framer', /framer/i],
    ['Vercel', /vercel/i],
  ];
  for (const [label, pattern] of techChecks) {
    if ((homepageHtml && pattern.test(homepageHtml)) || uniqueSources.some((s) => pattern.test(s.url))) {
      techSignals.push(`uses ${label}`);
    }
  }
  const competitiveLandscape = [];
  for (const result of uniqueSources) {
    try {
      const host = new URL(result.url).hostname.replace(/^www\./i, '');
      if (domain && host.includes(domain.replace(/^www\./i, ''))) continue;
      if (!competitiveLandscape.includes(host)) competitiveLandscape.push(host);
    } catch {
      // ignore
    }
    if (competitiveLandscape.length >= 5) break;
  }

  const inferredCompanyName = company || orgProfiles[0]?.name || homepage?.title?.split('|')[0]?.trim() || null;

  return {
    ok: true,
    endpoint: '/enrich',
    enriched_at: new Date().toISOString(),
    domain: domain || null,
    company_name: inferredCompanyName,
    industry_signals: [
      payload.industry || payload.sector || payload.category || null,
      ...(company ? [company] : []),
    ].filter(Boolean),
    web_presence: {
      main_site: homepage?.url || website || (domain ? `https://${domain}` : null),
      social,
      tech_signals: techSignals,
      contact_signals: {
        emails,
        phones,
      },
    },
    organization_profiles: orgProfiles,
    content_summary: {
      title: homepage?.title || null,
      description: homepage?.description || null,
      headings: homepage?.headings || [],
      visible_text_excerpt: homepageText.slice(0, 700) || null,
    },
    competitive_landscape: competitiveLandscape,
    company: {
      name: inferredCompanyName,
      domain,
      website: website || (domain ? `https://${domain}` : null),
    },
    website: homepage,
    searchResults: uniqueSources,
    sources: uniqueSources.map((x) => x.url),
    notes: [
      'Search results are live web signals; website snapshot is fetched directly when reachable.',
      'JSON-LD organization data, contact hints, and visible text excerpt are extracted from the homepage when available.',
      'Use the sources list to continue deeper manual or automated enrichment.',
    ],
  };
}

function marketIntel(payload = {}) {
  const sector = payload.sector || payload.industry || null;
  const geo = payload.geo || payload.region || payload.location || null;
  const anchor = payload.company || null;
  const queries = [];
  if (sector && geo) queries.push(`${sector} companies in ${geo}`);
  if (sector) queries.push(`${sector} companies`);
  if (sector && geo) queries.push(`${sector} ${geo} business directory`);
  if (anchor) queries.push(`${anchor} competitors ${geo || ''}`.trim());
  const rawResults = [];
  for (const query of queries.slice(0, 4)) {
    for (const url of runSearch(query, 5)) rawResults.push({ query, url });
  }
  const seen = new Set();
  const searchResults = [];
  for (const row of rawResults) {
    if (seen.has(row.url)) continue;
    seen.add(row.url);
    searchResults.push(row);
  }
  const targets = searchResults.map((row) => {
    const titleGuess = row.url.replace(/^https?:\/\//, '').split('/')[0];
    return {
      name: titleGuess.replace(/^www\./i, ''),
      url: row.url,
      sourceQuery: row.query,
    };
  });
  return {
    ok: true,
    endpoint: '/market-intel',
    market: { sector, geo, anchor },
    searchResults,
    targets,
    summary: {
      targetCount: targets.length,
      queriesUsed: queries,
    },
  };
}

function extractContractTerms(text, company) {
  const body = String(text || '').replace(/\r/g, '');
  const lower = body.toLowerCase();
  const patterns = [
    { name: 'auto_renewal', regex: /auto[- ]renew(al|s)|automatic renewal/i, risk: 8 },
    { name: 'termination_for_convenience', regex: /terminate.*convenience|termination for convenience/i, risk: 7 },
    { name: 'unilateral_change', regex: /unilateral|change.*at any time|modify.*without notice/i, risk: 8 },
    { name: 'indemnity', regex: /indemnif(y|ication)/i, risk: 7 },
    { name: 'assignment', regex: /assignment|assign.*without consent/i, risk: 5 },
    { name: 'confidentiality', regex: /confidential(ity| information)/i, risk: 4 },
    { name: 'governing_law', regex: /governing law|jurisdiction|venue/i, risk: 4 },
    { name: 'late_fee', regex: /late fee|interest.*past due|delinquen/i, risk: 5 },
    { name: 'audit_rights', regex: /audit rights?|inspection rights?/i, risk: 6 },
    { name: 'data_processing', regex: /data processing|subprocessor|processor|controller/i, risk: 6 },
    { name: 'non_solicit', regex: /non[- ]solicit|non[- ]compete/i, risk: 6 },
    { name: 'slas', regex: /service level|uptime|sla/i, risk: 4 },
    { name: 'minimum_term', regex: /minimum term|min(imum)? commitment|non-cancelable/i, risk: 7 },
    { name: 'payment_terms', regex: /net\s?\d+|payment due|invoice/i, risk: 4 },
  ];

  const terms = patterns.map((item) => {
    const match = body.match(item.regex);
    return {
      name: item.name,
      found: Boolean(match),
      evidence: match ? match[0].slice(0, 120) : null,
      risk: match ? item.risk : 0,
    };
  });

  const redFlags = terms.filter((t) => t.found && t.risk >= 6).map((t) => t.name);
  const clauses = terms.filter((t) => t.found).length;
  const riskScore = Math.min(100, terms.reduce((sum, t) => sum + t.risk, 0) * 4);
  const summary = redFlags.length
    ? `Detected ${redFlags.length} higher-risk terms across ${clauses} clauses.`
    : `Detected ${clauses} material contract terms with no major leakage flags.`;

  return {
    ok: true,
    endpoint: '/contract-analysis',
    company: company || null,
    riskScore,
    summary,
    terms,
    redFlags,
    excerpt: body.slice(0, 1500),
  };
}

function revenueFrictionPreflight(payload = {}) {
  const company = payload.company || null;
  const requestedUrl = normalizeUrl(payload.website || payload.domain || null);
  const suppliedText = String(payload.pageText || '').trim();
  const fetchedHtml = requestedUrl ? fetchUrl(requestedUrl) : '';
  const sourceText = suppliedText || stripTags(fetchedHtml);
  const searchable = `${fetchedHtml}\n${sourceText}`.toLowerCase();
  const observedSignals = [];

  const checks = [
    {
      id: 'visible_pricing',
      label: 'Visible pricing',
      pattern: /(?:\$|usd\s*)\d+(?:[.,]\d{1,2})?|pricing|plans?\s+(?:start|from|at)/i,
    },
    {
      id: 'purchase_cta',
      label: 'Purchase or booking call to action',
      pattern: /buy now|checkout|book now|schedule|start trial|get started|request (?:a )?quote|subscribe/i,
    },
    {
      id: 'payment_provider',
      label: 'Payment-provider integration',
      pattern: /stripe|paypal|squareup|shopify|paddle|braintree|authorize\.net/i,
    },
    {
      id: 'contact_path',
      label: 'Contact path',
      pattern: /mailto:|tel:|contact us|contact form|support@|sales@/i,
    },
    {
      id: 'recurring_terms',
      label: 'Recurring-price or subscription language',
      pattern: /per month|monthly|per year|annual(?:ly)?|subscription|recurring|auto[- ]renew/i,
    },
    {
      id: 'analytics',
      label: 'Analytics or conversion tracking',
      pattern: /googletagmanager|gtag\(|google-analytics|segment\.com|mixpanel|amplitude|facebook\.net\/en_us\/fbevents/i,
    },
  ];

  for (const check of checks) {
    if (check.pattern.test(searchable)) {
      observedSignals.push({
        id: check.id,
        label: check.label,
        observed: true,
        evidenceSource: fetchedHtml ? requestedUrl : 'buyer_supplied_page_text',
      });
    }
  }

  const observedIds = new Set(observedSignals.map((item) => item.id));
  const frictionFindings = [];
  const addFinding = (id, severity, observation, validation) => {
    frictionFindings.push({ id, severity, observation, validation });
  };

  if (!observedIds.has('purchase_cta')) {
    addFinding(
      'purchase_path_not_observed',
      'medium',
      'No clear purchase, booking, trial, subscription, or quote call to action was observed in the inspected content.',
      'Confirm the intended conversion action and inspect the rendered page before changing the site.',
    );
  }
  if (!observedIds.has('visible_pricing')) {
    addFinding(
      'pricing_not_observed',
      'low',
      'No visible price or pricing-plan language was observed in the inspected content.',
      'Confirm whether pricing is intentionally private and compare qualified conversion rates before testing disclosure.',
    );
  }
  if (!observedIds.has('contact_path')) {
    addFinding(
      'contact_path_not_observed',
      'medium',
      'No obvious contact route was observed in the inspected content.',
      'Verify contact and support routes in the rendered page and navigation.',
    );
  }
  if (!observedIds.has('analytics')) {
    addFinding(
      'conversion_measurement_not_observed',
      'medium',
      'No common analytics or conversion-tracking marker was observed in the retrieved source.',
      'Verify analytics through browser developer tools; absence in source does not prove tracking is missing.',
    );
  }

  const evidenceQuality = fetchedHtml
    ? 'direct_public_page_source'
    : suppliedText
      ? 'buyer_supplied_public_text'
      : 'insufficient_evidence';

  return {
    ok: Boolean(fetchedHtml || suppliedText),
    endpoint: '/revenue-friction-preflight',
    generatedAt: new Date().toISOString(),
    company,
    target: requestedUrl,
    evidenceQuality,
    observedSignals,
    frictionFindings,
    verifiedRecoverableRevenueUsd: 0,
    decisionBoundary: 'These are observable friction hypotheses, not proof of lost or recoverable revenue.',
    recommendedNextStep: frictionFindings.length
      ? 'Validate one finding with rendered-page evidence and a measured conversion test.'
      : 'Preserve the observed purchase path and verify it with transaction-level conversion data.',
    sources: fetchedHtml && requestedUrl ? [requestedUrl] : [],
    limitations: [
      'This preflight does not access private billing, analytics, CRM, or payment data.',
      'Source-code inspection may miss dynamically rendered controls and client-side tracking.',
      'No revenue amount is inferred from public website signals.',
    ],
  };
}

function airlockProofPacket(payload = {}) {
  return {
    ok: true,
    endpoint: '/airlock-proof-packet',
    generatedAt: new Date().toISOString(),
    offerId: 'xzenia.airlock.machine-payer.usdc-1.v1',
    buyerAgent: payload.buyerAgent || null,
    purpose: payload.purpose || null,
    artifact: {
      title: 'Xzenia Airlock First-Dollar Proof Packet',
      summary: 'A public proof packet for proof-bound autonomous labor: exact authorization gates, refusal evidence, provider-observed execution, and truth boundaries.',
      humanUrl: 'https://prettybusysolutions-eng.github.io/xzenia-leaklock/first-dollar.html',
      offerManifestUrl: 'https://prettybusysolutions-eng.github.io/xzenia-leaklock/first-dollar-offer.json',
      packageRepository: 'https://github.com/prettybusysolutions-eng/x402-mcp-server',
      proofFiles: [
        'commercial/xzenia-first-dollar-distribution-proof-20260701.md',
        'commercial/xzenia-first-dollar-superteam-imperial-submission-packet-20260701.md',
      ],
    },
    truthBoundary: {
      externalPaymentRequired: true,
      selfPaymentCountsAsRevenue: false,
      noSensitiveDataRequired: true,
      noRecoveredRevenueClaim: true,
      noSecurityCertificationClaim: true,
    },
    fulfillment: {
      mode: 'automatic_after_verified_x402_settlement',
      delivered: true,
      nextStep: 'If the buyer wants a custom audit, request a separate human-approved scope. This endpoint only delivers the public proof packet.',
    },
  };
}

function buildDiscovery(baseUrl) {
  return {
    ok: true,
    protocol: 'x402',
    version: 2,
    service: SERVICE_NAME,
    network: NETWORK,
    facilitator: FACILITATOR_URL,
    payTo: WALLET_ADDRESS,
    publicUrl: baseUrl,
    routes: ROUTES.map((route) => ({
      method: route.method,
      path: route.path,
      description: route.description,
      pricing: {
        scheme: 'exact',
        network: NETWORK,
        price: route.price,
        payTo: WALLET_ADDRESS,
      },
      config: route.config,
    })),
  };
}

function buildOpenApi(baseUrl) {
  const paths = Object.fromEntries(ROUTES.map((route) => {
    const method = route.method.toLowerCase();
    return [route.path, {
      [method]: {
        summary: route.description,
        description: `${route.description}. Payment required via x402 exact scheme on ${NETWORK} to ${WALLET_ADDRESS}. Price ${route.price}.`,
        operationId: route.path.replace(/^\//, '').replace(/-/g, '_'),
        requestBody: {
          required: false,
          content: {
            'application/json': {
              schema: route.config.inputSchema,
            },
          },
        },
        responses: {
          200: {
            description: 'Successful paid response',
            content: {
              'application/json': {
                schema: route.config.outputSchema,
              },
            },
          },
          402: {
            description: 'x402 payment required',
          },
        },
        'x-x402': {
          scheme: 'exact',
          network: NETWORK,
          price: route.price,
          payTo: WALLET_ADDRESS,
          facilitator: FACILITATOR_URL,
          discovery: `${baseUrl}/.well-known/x402`,
        },
      },
    }];
  }));

  return {
    openapi: '3.1.0',
    info: {
      title: 'Xzenia Enrichment API',
      version: '1.0.0',
      description: 'Machine-payable enrichment, market intelligence, and contract-analysis endpoints. Use x402 discovery for payment requirements before calling.',
    },
    servers: [{ url: baseUrl }],
    paths,
  };
}

function buildAiPlugin(baseUrl) {
  return {
    schema_version: 'v1',
    name_for_human: 'Xzenia Enrichment API',
    name_for_model: 'xzenia_enrichment_api',
    description_for_human: 'Machine-payable enrichment, market intelligence, and contract analysis.',
    description_for_model: 'Paid API for company/domain enrichment, geography-specific market intelligence, and contract term risk analysis. Check /.well-known/x402 for prices and payment requirements, then call the endpoint with an x402 payment.',
    auth: { type: 'none' },
    api: {
      type: 'openapi',
      url: `${baseUrl}/openapi.json`,
      is_user_authenticated: false,
    },
    logo_url: `${baseUrl}/favicon.ico`,
    contact_email: 'ops@prettybusysolutions.com',
    legal_info_url: baseUrl,
  };
}

function buildLlmsTxt(baseUrl) {
  const routeLines = ROUTES.map((route) => `- ${route.method} ${route.path} — ${route.description} — ${route.price}`).join('\n');
  return `# Xzenia Enrichment API\n\nMachine-payable API for agents and autonomous systems.\n\n## Discovery\n- x402 discovery: ${baseUrl}/.well-known/x402\n- OpenAPI: ${baseUrl}/openapi.json\n- AI Plugin: ${baseUrl}/.well-known/ai-plugin.json\n\n## Payment\n- Protocol: x402 exact\n- Network: ${NETWORK}\n- Pay-to: ${WALLET_ADDRESS}\n- Facilitator: ${FACILITATOR_URL}\n\n## Endpoints\n${routeLines}\n\n## Notes for agents\n- Expect HTTP 402 on unpaid requests.\n- Read /.well-known/x402 first to discover prices and schemas.\n- Designed for machine-to-machine callers; no human checkout flow required.\n`;
}

function buildRouteConfig(route) {
  const discoveryExtension = declareDiscoveryExtension({
    method: route.method,
    bodyType: 'json',
    inputSchema: route.config.inputSchema,
    output: {
      schema: route.config.outputSchema,
      example: route.path === '/enrich'
        ? { ok: true, endpoint: '/enrich', company: { name: 'Acme', domain: 'acme.com' } }
        : route.path === '/market-intel'
          ? { ok: true, endpoint: '/market-intel', market: { sector: 'property management', geo: 'Tampa' } }
          : route.path === '/contract-analysis'
            ? { ok: true, endpoint: '/contract-analysis', riskScore: 42, redFlags: [] }
            : route.path === '/airlock-proof-packet'
              ? {
                  ok: true,
                  endpoint: '/airlock-proof-packet',
                  offerId: 'xzenia.airlock.machine-payer.usdc-1.v1',
                  artifact: {
                    title: 'Xzenia Airlock First-Dollar Proof Packet',
                    humanUrl: 'https://prettybusysolutions-eng.github.io/xzenia-leaklock/first-dollar.html',
                  },
                }
              : {
                  ok: true,
                  endpoint: '/revenue-friction-preflight',
                  evidenceQuality: 'direct_public_page_source',
                  frictionFindings: [],
                  verifiedRecoverableRevenueUsd: 0,
                },
    },
  });

  return {
    accepts: {
      scheme: 'exact',
      price: route.price,
      network: NETWORK,
      payTo: WALLET_ADDRESS,
    },
    description: route.description,
    mimeType: 'application/json',
    extensions: discoveryExtension,
  };
}

function makeRoutesConfig() {
  return Object.fromEntries(ROUTES.map((route) => [route.path, buildRouteConfig(route)]));
}

async function createFacilitatorAuthHeaders() {
  if (!IS_MAINNET) return {};
  if (!generateJwt) throw new Error('CDP SDK auth module not installed');
  const apiKeyId = process.env.CDP_API_KEY_ID;
  const apiKeySecret = process.env.CDP_API_KEY_SECRET;
  if (!apiKeyId || !apiKeySecret) {
    throw new Error('Missing CDP_API_KEY_ID or CDP_API_KEY_SECRET');
  }

  async function bearer(method, pathName) {
    const token = await generateJwt({
      apiKeyId,
      apiKeySecret,
      requestMethod: method,
      requestHost: CDP_HOST,
      requestPath: `/platform/v2/x402/${pathName}`,
      expiresIn: 120,
    });
    return { Authorization: `Bearer ${token}` };
  }

  return {
    supported: await bearer('GET', 'supported'),
    verify: await bearer('POST', 'verify'),
    settle: await bearer('POST', 'settle'),
  };
}

async function start() {
  ensureRequestLogDb();
  if (!fs.existsSync(SEARCH_SH)) {
    console.warn(`search helper missing: ${SEARCH_SH}`);
  }
  if (IS_MAINNET) {
    const missing = [];
    if (!process.env.CDP_API_KEY_ID) missing.push('CDP_API_KEY_ID');
    if (!process.env.CDP_API_KEY_SECRET) missing.push('CDP_API_KEY_SECRET');
    if (missing.length) {
      console.warn(`mainnet requested but missing: ${missing.join(', ')}`);
    }
  }

  const app = express();
  app.set('trust proxy', true);
  app.use(express.json({ limit: '5mb' }));
  app.use(express.urlencoded({ extended: true, limit: '5mb' }));
  app.use(createRequestLogger());

  const facilitatorClient = new HTTPFacilitatorClient({
    url: FACILITATOR_URL,
    createAuthHeaders: createFacilitatorAuthHeaders,
  });
  const resourceServer = new x402ResourceServer(facilitatorClient)
    .register(NETWORK, new ExactEvmScheme())
    .registerExtension(bazaarResourceServerExtension);

  try {
    await resourceServer.initialize();
  } catch (error) {
    console.warn('x402 resource server initialization warning:', error?.message || error);
  }

  app.get('/health', (req, res) => {
    res.json({
      ok: true,
      service: SERVICE_NAME,
      network: NETWORK,
      payTo: WALLET_ADDRESS,
      facilitator: FACILITATOR_URL,
      publicUrl: readPublicUrl(),
      searchHelper: fs.existsSync(SEARCH_SH),
    });
    flushRequestLog(req, res);
  });

  app.get('/pricing', (req, res) => {
    res.json({
      ok: true,
      service: SERVICE_NAME,
      network: NETWORK,
      payTo: WALLET_ADDRESS,
      routes: ROUTES.map(({ path: routePath, price }) => ({ path: routePath, price })),
    });
    flushRequestLog(req, res);
  });

  app.get('/revenue-loop', (req, res) => {
    res.json(buildRevenueLoopStatus(settledPreflightSales()));
    flushRequestLog(req, res);
  });

  app.get('/.well-known/x402', (req, res) => {
    const baseUrl = readPublicUrl() || `${req.protocol}://${req.get('host')}`;
    res.json(buildDiscovery(baseUrl));
    flushRequestLog(req, res);
  });

  app.get('/openapi.json', (req, res) => {
    const baseUrl = readPublicUrl() || `${req.protocol}://${req.get('host')}`;
    res.json(buildOpenApi(baseUrl));
    flushRequestLog(req, res);
  });

  app.get('/.well-known/ai-plugin.json', (req, res) => {
    const baseUrl = readPublicUrl() || `${req.protocol}://${req.get('host')}`;
    res.json(buildAiPlugin(baseUrl));
    flushRequestLog(req, res);
  });

  app.get('/llms.txt', (req, res) => {
    const baseUrl = readPublicUrl() || `${req.protocol}://${req.get('host')}`;
    res.type('text/plain').send(buildLlmsTxt(baseUrl));
    flushRequestLog(req, res);
  });

  app.use(paymentMiddleware(makeRoutesConfig(), resourceServer, {
    appName: 'Xzenia Enrichment API',
    currentUrl: readPublicUrl() || undefined,
    testnet: !IS_MAINNET,
  }));

  app.post('/enrich', (req, res) => {
    res.json(enrichCompany(req.body || {}));
    flushRequestLog(req, res);
  });

  app.post('/market-intel', (req, res) => {
    res.json(marketIntel(req.body || {}));
    flushRequestLog(req, res);
  });

  app.post('/contract-analysis', (req, res) => {
    const body = req.body || {};
    const text = body.contractsText || body.contractText || '';
    const url = body.contractUrl || body.url || '';
    const fetched = text || (url ? fetchUrl(url) : '');
    if (!fetched) {
      res.status(400).json({ ok: false, error: 'Provide contractsText, contractText, or contractUrl.' });
      flushRequestLog(req, res);
      return;
    }
    res.json(extractContractTerms(fetched, body.company || null));
    flushRequestLog(req, res);
  });

  app.post('/airlock-proof-packet', (req, res) => {
    res.json(airlockProofPacket(req.body || {}));
    flushRequestLog(req, res);
  });

  app.post('/revenue-friction-preflight', (req, res) => {
    res.json(revenueFrictionPreflight(req.body || {}));
    flushRequestLog(req, res);
  });

  app.listen(PORT, HOST, () => {
    console.log(`x402 service listening on ${HOST}:${PORT}`);
    console.log(`network: ${NETWORK}`);
    console.log(`payTo: ${WALLET_ADDRESS}`);
    console.log(`facilitator: ${FACILITATOR_URL}`);
  });
}

module.exports = {
  enrichCompany,
  marketIntel,
  extractContractTerms,
  revenueFrictionPreflight,
  airlockProofPacket,
  isSafePublicUrl,
  buildRevenueLoopStatus,
  buildDiscovery,
  readPublicUrl,
};

if (require.main === module) {
  start().catch((error) => {
    console.error('x402 server failed to start:', error);
    process.exit(1);
  });
}
