# Quickstart

This path evaluates the MCP server without a wallet or paid request.

```bash
git clone https://github.com/prettybusysolutions-eng/x402-mcp-server.git
cd x402-mcp-server
npm ci
npm test
```

Start the MCP server over stdio:

```bash
node mcp-server.js
```

For an MCP client, use the checked-in
[`claude_desktop_config.example.json`](claude_desktop_config.example.json) and
omit `BASE_MAINNET_PAYER_KEY` until you intentionally test a paid route.

## Expected boundary

The test suite verifies local server behavior and syntax. It does not prove
that a public payment endpoint is reachable, that a settlement occurred, or
that an external client adopted the server.
