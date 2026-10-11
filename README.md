# x402-intelligence

A paid, x402-compliant MCP server for on-chain contract analysis and data enrichment. Settles autonomously via USDC on Base Mainnet.

**Start here:** [run the credential-free MCP quickstart](QUICKSTART.md).

See [MCP-README.md](MCP-README.md) for the registry bundle, Claude Desktop
configuration block, tools, endpoint economics, and paid-call requirements.

## What can be evaluated without payment

- install and dependency integrity with `npm ci`;
- syntax and behavioral tests with `npm test`;
- MCP server startup and `x402_metadata` discovery;
- configuration examples for compatible MCP clients.

Paid tool calls use real USDC on Base mainnet. Do not configure a payer key for
the credential-free evaluation path.

## Xzenia Airlock proof packet

The first-dollar proof packet for proof-bound autonomous labor is exposed two
ways:

- x402 machine-payer route: `POST /airlock-proof-packet` for `1.00 USDC`
- public human/agent reference page:
  https://prettybusysolutions-eng.github.io/xzenia-leaklock/first-dollar.html
- machine-readable Stripe fallback offer:
  https://prettybusysolutions-eng.github.io/xzenia-leaklock/first-dollar-offer.json

The x402 route is the native machine-to-machine path. The GitHub Pages offer is
the public reference and human checkout fallback.

This packet is a public artifact and does not require private data, wallet
handoff, dashboard access, or a consulting intake.

Revenue truth boundary: a page view, package install, or checkout start is not
revenue. The first dollar only counts after Stripe reports a paid checkout
session or the x402 request ledger records a unique settled external transaction
for the proof packet.

## Release and license

- [Release procedure and current version boundary](RELEASING.md)
- MIT licensed; see [LICENSE](LICENSE)

## Settlement and release evidence limits

Facilitator initialization failures stop paid-server startup. Revenue status is
PARTIAL with null metrics and HTTP 503 on testnet or inaccessible accounting logs;
it does not substitute zero for unknown revenue. Successful configured-network
transaction headers are required, self-payer addresses are excluded, and transaction
IDs deduplicate reported sales. Request logs no longer retain contract text or arbitrary
customer bodies. SQLite CLI remains a runtime prerequisite.

Synthetic decoder and ledger-input tests do not establish real on-chain settlement,
delivery after settlement, refund handling, replay safety or independent payer identity.
A controlled testnet purchase and externally funded mainnet integration remain gates.
Dependency changes and this code are not yet a synchronized npm/GitHub release; no
registry publication is claimed. Reconcile historic logs before using revenue metrics.
