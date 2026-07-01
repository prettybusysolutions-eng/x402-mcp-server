# x402-intelligence

A paid, x402-compliant MCP server for on-chain contract analysis and data enrichment. Settles autonomously via USDC on Base Mainnet.

## $1 Xzenia Airlock proof packet

- Human page: https://prettybusysolutions-eng.github.io/xzenia-leaklock/first-dollar.html
- Machine-readable offer: https://prettybusysolutions-eng.github.io/xzenia-leaklock/first-dollar-offer.json

This public packet shows the governed-action/refusal boundary used by Xzenia
without requiring private data, dashboard credentials, wallet handoff, or a
consulting intake.

Truth boundary: a page view, package install, or checkout start is not revenue.
The first dollar only counts after Stripe reports a paid checkout session for
the proof packet.

## Install / run with `npx`

```bash
npx -y @xzenithai/x402-mcp-server
```

## Claude Desktop config

Copy-paste into `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "x402-intelligence": {
      "command": "npx",
      "args": [
        "-y",
        "@xzenithai/x402-mcp-server"
      ],
      "env": {
        "X402_PUBLIC_URL": "https://generating-houston-ports-wealth.trycloudflare.com",
        "BASE_MAINNET_PAYER_KEY": "<USER_PRIVATE_KEY_HERE>"
      }
    }
  }
}
```

## Tools

- `x402_metadata`
- `enrich`
- `market_intel`
- `contract_analysis`

## Endpoint economics

- `/enrich` — `0.05 USDC`
- `/market-intel` — `0.10 USDC`
- `/contract-analysis` — `0.50 USDC`

## Environment

- `X402_PUBLIC_URL` — public x402 base URL, e.g. `https://generating-houston-ports-wealth.trycloudflare.com`
- `BASE_MAINNET_PAYER_KEY` — Base mainnet private key used to satisfy x402 payment challenges
- `BASE_RPC_URL` — optional RPC override; defaults to `https://mainnet.base.org`
- `X402_PAYER_KEY_FILE` — optional local key file fallback when `BASE_MAINNET_PAYER_KEY` is not set

## Local test

```bash
mcporter call --stdio "node mcp-server.js" x402_metadata
mcporter call --stdio "node mcp-server.js" enrich company="Acme" domain=acme.com website=https://acme.com
```

## Important

- Paid tool calls spend real USDC on Base mainnet.
- The public discovery document should remain live at `/.well-known/x402` for reliable client negotiation.
- This package is designed for MCP registries, Claude Desktop, and other MCP-compliant orchestrators.
