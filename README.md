# x402-intelligence

A paid, x402-compliant MCP server for on-chain contract analysis and data enrichment. Settles autonomously via USDC on Base Mainnet.

See `MCP-README.md` for the registry bundle, Claude Desktop configuration block, and usage details.

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
