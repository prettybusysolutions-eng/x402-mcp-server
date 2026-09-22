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
