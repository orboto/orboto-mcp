# `@orbit/mcp`

Model Context Protocol server for Orbit. Exposes 42 tools, 4 resources, and 5 prompts so MCP-aware AI clients (Claude Desktop, Cursor, GitHub Copilot Chat) can read and write Orbit data as a regular API user.

> **Operators**: head to [`docs/mcp-setup.md`](../../docs/mcp-setup.md) for the per-client setup walkthrough. The README below is for contributors hacking on the MCP package itself.

## Layout

```
src/
  index.ts             entry point — picks transport from ORBIT_MCP_TRANSPORT
  server.ts            McpServer factory + tool/resource/prompt registration
  http-transport.ts    Streamable HTTP transport for the Self-Hosted-Inline mode
  orbit-client.ts      tiny REST client wrapping the Orbit API
  resources.ts         registerResource() calls
  prompts.ts           registerPrompt() calls
  tools/               one file per tool category (tickets, time, primer-facts, …)
  with-metrics.ts      lightweight metrics decorator wrapping every handler
```

## Dev

```bash
pnpm --filter @orbit/mcp dev          # tsx watch with stdio transport
pnpm --filter @orbit/mcp build        # tsc → dist/
pnpm --filter @orbit/mcp test         # vitest
```

A live API instance is required — the dev mode preflights against `/users/me` on boot. Easiest setup:

```bash
# Terminal 1 — Orbit stack
docker compose -f docker-compose.local.yml up -d
pnpm --filter @orbit/api dev

# Terminal 2 — MCP server
ORBIT_API_URL=http://localhost:3000 \
ORBIT_API_KEY=orb_… \
pnpm --filter @orbit/mcp dev
```

Mint the API key under Profile → API keys (the user must have the `mcp:use` permission — see `apps/api/src/db/seed.ts`).

## Env vars

See [`docs/env.md`](../../docs/env.md#mcp-server-orbitmcp) for the complete list. Quick reference:

| Var | Required | Purpose |
|---|---|---|
| `ORBIT_API_URL` | yes | API base URL (`http://api:3000` inside compose, public URL otherwise). |
| `ORBIT_API_KEY` | stdio only | `orb_…` token; HTTP mode reads it per-request from the `Authorization` header instead. |
| `ORBIT_MCP_TRANSPORT` | no | `stdio` (default) or `http`. |
| `ORBIT_MCP_PORT` | http only | Listen port (default `3100`). |
| `ORBIT_MCP_CLIENT` | no | User-Agent suffix sent on every Orbit API call. |

## Three-way sync

Per [`CLAUDE.md`](../../CLAUDE.md), every API route change ships in one commit bundle that updates:

1. `apps/api/` — the route + tests
2. `apps/mcp/src/tools/` — the tool wrapper + unit test fixture (this package)
3. `.claude/skills/orbit/` — the SKILL.md operation row + `scripts/orbit.mjs` shortcut where it makes sense

Skipping any one drifts the consuming surfaces out of sync with the producing route. Adding a new tool here means: new file under `tools/`, register it in `server.ts`, add a unit test under `tools/<name>.test.ts`.
