# `@orboto/mcp`

Model Context Protocol server for Orboto. Exposes 64 tools, 4 resources, and 5 prompts so MCP-aware AI clients (Claude Desktop, Cursor, GitHub Copilot Chat) can read and write Orboto data as a regular API user.

> **Operators**: head to [`docs/mcp-setup.md`](../../docs/mcp-setup.md) for the per-client setup walkthrough. The README below is for contributors hacking on the MCP package itself.

## Layout

```
src/
  index.ts             entry point — picks transport from ORBOTO_MCP_TRANSPORT
  server.ts            McpServer factory + tool/resource/prompt registration
  http-transport.ts    Streamable HTTP transport for the Self-Hosted-Inline mode
  orboto-client.ts     tiny REST client wrapping the Orboto API
  resources.ts         registerResource() calls
  prompts.ts           registerPrompt() calls
  tools/               one file per tool category (tickets, time, primer-facts, …)
  with-metrics.ts      lightweight metrics decorator wrapping every handler
```

## Dev

```bash
pnpm --filter @orboto/mcp dev          # tsx watch with stdio transport
pnpm --filter @orboto/mcp build        # tsc → dist/
pnpm --filter @orboto/mcp test         # vitest
```

A live API instance is required — the dev mode preflights against `/users/me` on boot. Easiest setup:

```bash
# Terminal 1 — Orboto stack
docker compose -f docker-compose.local.yml up -d
pnpm --filter @orboto/api dev

# Terminal 2 — MCP server
ORBOTO_API_URL=http://localhost:3000 \
ORBOTO_API_KEY=orb_… \
pnpm --filter @orboto/mcp dev
```

Mint the API key under Profile → API keys (the user must have the `mcp:use` permission — see `apps/api/src/db/seed.ts`).

## Env vars

See [`docs/env.md`](../../docs/env.md#mcp-server-orbitmcp) for the complete list. Quick reference:

| Var | Required | Purpose |
|---|---|---|
| `ORBOTO_API_URL` | yes | API base URL (`http://api:3000` inside compose, public URL otherwise). |
| `ORBOTO_API_KEY` | stdio only | `orb_…` token; HTTP mode reads it per-request from the `Authorization` header instead. |
| `ORBOTO_MCP_TRANSPORT` | no | `stdio` (default) or `http`. |
| `ORBOTO_MCP_PORT` | http only | Listen port (default `3100`). |
| `ORBOTO_MCP_CLIENT` | no | User-Agent suffix sent on every Orboto API call. |

## Three-way sync

Per [`CLAUDE.md`](../../CLAUDE.md), every API route change ships in one commit bundle that updates:

1. `apps/api/` — the route + tests
2. `apps/mcp/src/tools/` — the tool wrapper + unit test fixture (this package)
3. `.claude/skills/orboto/` — the SKILL.md operation row + `scripts/orboto.mjs` shortcut where it makes sense

Skipping any one drifts the consuming surfaces out of sync with the producing route. Adding a new tool here means: new file under `tools/`, register it in `server.ts`, add a unit test under `tools/<name>.test.ts`.

## Tools — wrapper-feature parity (ORB-799)

The MCP tool surface is feature-equivalent to the `orboto` Bash wrapper (`scripts/orboto.mjs` in `.claude/skills/orboto/`). Per the `feedback_prefer_mcp_in_claude_code` operator policy: in Claude Code sessions where the MCP server is active, prefer MCP tools over the wrapper. Wrapper-only by design:

- `init` — Repo bootstrap (writes CLAUDE.md / AGENTS.md skill pointer)
- `self-update` — skill bundle version management
- Raw `get / post / patch / put / delete <path>` — escape hatch; MCP is typed-only by design

| Cluster | Tools |
|---|---|
| Identity | `orboto_whoami`, `orboto_ai_status` |
| Discovery | `orboto_list_projects`, `orboto_get_project`, `orboto_get_project_primer`, `orboto_list_milestones`, `orboto_get_milestone`, `orboto_list_doc_spaces`, `orboto_get_doc`, `orboto_list_ticket_statuses`, `orboto_list_labels`, `orboto_list_git_app_installations`, `orboto_list_users` |
| Ticket read | `orboto_get_ticket`, `orboto_list_tickets`, `orboto_my_tickets`, `orboto_search`, `orboto_query`, `orboto_get_checklists`, `orboto_get_timer`, `orboto_list_ticket_dependencies` |
| Ticket write | `orboto_create_ticket`, `orboto_update_ticket`, `orboto_move_ticket`, `orboto_close_ticket`, `orboto_comment`, `orboto_assign`, `orboto_unassign`, `orboto_set_milestone`, `orboto_set_parent`, `orboto_add_ticket_dependency`, `orboto_remove_ticket_dependency` |
| Composite | `orboto_claim` (assign self + in_progress + timer start), `orboto_unclaim` (unassign self + todo) |
| Milestone CRUD | `orboto_create_milestone`, `orboto_close_milestone`, `orboto_update_milestone` |
| Checklists | `orboto_check`, `orboto_uncheck`, `orboto_add_check`, `orboto_new_checklist` |
| Time | `orboto_timer_start`, `orboto_timer_stop`, `orboto_log_time` |
| Bulk | `orboto_bulk_patch_tickets`, `orboto_bulk_move_tickets`, `orboto_bulk_close_tickets`, `orboto_bulk_comment_tickets`, `orboto_bulk_assign_tickets`, `orboto_bulk_unassign_tickets` |
| Docs-AI | `orboto_ask_docs`, `orboto_ingest_url`, `orboto_ingest_file` |
| Attachments | `orboto_attach_to_ticket` |
| Primer facts | `orboto_primer_fact_list`, `orboto_primer_fact_add`, `orboto_primer_fact_update`, `orboto_primer_fact_supersede`, `orboto_primer_fact_verify`, `orboto_primer_fact_delete` |
| Admin | `orboto_get_audit_log`, `orboto_trigger_backup` |

**Bulk semantics**: each `orboto_bulk_*` tool takes `ticketKeys: string[]` (up to 200), an optional `dryRun: boolean`, and returns `{ successful, failed: [{ ticketKey, error }], skipped, dryRun }`. Partial failure is the norm — branch on the structured outcome rather than relying on exit status.

**File-upload tools** (`orboto_ingest_file`, `orboto_attach_to_ticket`): the model does not need local FS access. The bytes come over the wire as a base64 `contentBase64` field; the tool decodes + multipart-uploads internally.

**`orboto_set_parent` vs `orboto_update_ticket`**: re-parenting an existing ticket is intentionally NOT part of the `orboto_update_ticket` patch shape. Use the dedicated tool (symmetric to `orboto_set_milestone`) — `parentTicketKey: null` detaches from any parent.
