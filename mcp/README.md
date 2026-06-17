# ClipWarp MCP Server

A standalone [Model Context Protocol](https://modelcontextprotocol.io) (stdio) server named
`clipwarp` that lets an AI agent (e.g. Claude Code) push, pull, and search clips in your
ClipWarp cloud clipboard over its HTTP REST API.

It talks **only** to ClipWarp's REST API and authenticates with a personal access token.

## Tools

| Tool | Description |
| --- | --- |
| `clipboard_push` | Push text to the clipboard. Optional `burnAfterRead`, `ttlSeconds`. |
| `clipboard_pull` | Fetch the most recent clips (default 10, max 50). |
| `clipboard_search` | Full-text search clips (default 10, max 50). |

## Install

```bash
cd /Users/panda/github/ClipWarp/mcp
npm install
```

Requires Node.js >= 22 (uses the built-in global `fetch`).

## Configuration

Set via environment variables:

| Variable | Required | Default | Notes |
| --- | --- | --- | --- |
| `CLIPWARP_URL` | no | `http://localhost:2547` | Base URL of your ClipWarp server. |
| `CLIPWARP_TOKEN` | yes | — | A `cw_pat_...` personal access token. |

Get a token from the ClipWarp web UI: **设置 → 个人访问令牌** (which calls `POST /api/tokens`).
If `CLIPWARP_TOKEN` is missing the server still starts, but every tool call returns an
error telling you to set it.

## Register with Claude Code

```bash
claude mcp add clipwarp \
  --env CLIPWARP_URL=http://localhost:2547 \
  --env CLIPWARP_TOKEN=cw_pat_your_token_here \
  -- node /Users/panda/github/ClipWarp/mcp/index.js
```

Then restart Claude Code or run `/mcp` to load the `clipwarp` tools.

## Manual config block

If you register MCP servers via JSON config instead, use:

```json
{
  "mcpServers": {
    "clipwarp": {
      "command": "node",
      "args": ["/Users/panda/github/ClipWarp/mcp/index.js"],
      "env": {
        "CLIPWARP_URL": "http://localhost:2547",
        "CLIPWARP_TOKEN": "cw_pat_your_token_here"
      }
    }
  }
}
```

## Test

```bash
npm test
```

The smoke test covers the pure clip-formatting logic and runs **without** a running
ClipWarp server (no network calls).

## Security

stdout is the MCP transport channel — only the transport writes to it. Clip content and
the access token are never written to stdout, stderr, or any log.
