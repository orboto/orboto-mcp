#!/usr/bin/env node
/**
 * ORB-244 Phase A — entry point for `@orboto/mcp`.
 *
 * Two transport modes, picked by env:
 *   ORBOTO_MCP_TRANSPORT=stdio (default)  — JSON-RPC over stdin/stdout,
 *     used by the Local-Proxy delivery variant. Claude Desktop spawns
 *     this process via the `claude_desktop_config.json` snippet and
 *     talks over its own stdio pair.
 *   ORBOTO_MCP_TRANSPORT=http             — Streamable HTTP per MCP
 *     spec. Used by the Self-Hosted-inline + Cloud-Managed variants
 *     (separate container listening on a port the reverse proxy maps
 *     to `/mcp`). Sessions carry `mcp-session-id` for server→client
 *     notifications.
 *
 * Config (env-only — no config file):
 *   ORBOTO_API_URL        required — base URL of the orboto API
 *   ORBOTO_API_KEY        required — `orb_*` API key with `mcp:use`
 *                         scope (stdio mode). Per-session bearer token
 *                         is read from Authorization header in http mode.
 *   ORBOTO_MCP_TRANSPORT  optional — `stdio` (default) | `http`
 *   ORBOTO_MCP_PORT       optional — port for http transport, default 3100
 *   ORBOTO_MCP_CLIENT     optional — client hint for User-Agent (e.g.
 *                         `claude-desktop`, `cursor`).
 */
import { buildOrbotoMcpServer } from './server.js';
import { OrbotoClient, preflightMcpSession } from './orboto-client.js';

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v || v.length === 0) {
    process.stderr.write(`[orboto-mcp] missing required env var: ${name}\n`);
    process.exit(2);
  }
  return v;
}

async function main() {
  const transport = (process.env.ORBOTO_MCP_TRANSPORT ?? 'stdio').toLowerCase();

  if (transport === 'stdio') {
    // Local-Proxy mode — one MCP client, one process, one API key.
    // All config read at boot; no per-request auth needed because the
    // only user of this stdio pair is the client that spawned us.
    const baseUrl = requireEnv('ORBOTO_API_URL');
    const apiKey = requireEnv('ORBOTO_API_KEY');
    const userAgentSuffix = process.env.ORBOTO_MCP_CLIENT;

    // Preflight BEFORE spinning up the transport — so a
    // mis-configured install fails loudly to stderr instead of
    // silently hanging on stdin waiting for JSON-RPC frames.
    const preflightClient = new OrbotoClient({ baseUrl, apiKey, userAgentSuffix });
    try {
      const { userEmail } = await preflightMcpSession(preflightClient);
      // eslint-disable-next-line no-console
      console.error(`[orboto-mcp] authenticated as ${userEmail} → ${baseUrl}`);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`[orboto-mcp] ${(err as Error).message}`);
      process.exit(1);
    }

    const server = buildOrbotoMcpServer({ baseUrl, apiKey, userAgentSuffix });
    const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js');
    const stdio = new StdioServerTransport();
    await server.connect(stdio);
    // The SDK writes its own "connected" log to stderr; we don't
    // echo anything here — stdout is reserved for JSON-RPC frames
    // and an accidental console.log would corrupt the protocol.
    return;
  }

  if (transport === 'http') {
    // Self-Hosted + Cloud-Managed mode. The bearer token comes from
    // the caller (Claude Desktop / Cursor) on every POST — a per-
    // session server is built so each session carries its own
    // API-key scoped OrbotoClient.
    const port = Number(process.env.ORBOTO_MCP_PORT ?? '3100');
    const baseUrl = requireEnv('ORBOTO_API_URL');
    const { createHttpServer } = await import('./http-transport.js');
    const httpServer = createHttpServer({ baseUrl });
    httpServer.listen(port, () => {
      // stderr so self-hosted operators can tail the container log
      // without parsing the JSON on stdout (stdio mode).
      // eslint-disable-next-line no-console
      console.error(`[orboto-mcp] http listening on :${port} → ${baseUrl}`);
    });
    return;
  }

  // eslint-disable-next-line no-console
  console.error(`[orboto-mcp] unknown ORBOTO_MCP_TRANSPORT=${transport} (expected 'stdio' or 'http')`);
  process.exit(1);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[orboto-mcp] fatal:', err);
  process.exit(1);
});
