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
 *   ORBOTO_API_KEY        optional — `orb_*` API key with `mcp:use`
 *                         scope (stdio mode). Service-account fallback;
 *                         when omitted, stdio mode bootstraps via OAuth
 *                         (ORB-943) so a desktop user connects through the
 *                         workspace login without pasting a token. Per-
 *                         session bearer is read from the Authorization
 *                         header in http mode.
 *   ORBOTO_AUTH           optional — `pat` | `oauth`. Defaults to `pat`
 *                         when ORBOTO_API_KEY is set, else `oauth`. Force
 *                         `oauth` to run the browser bootstrap even with a
 *                         key present.
 *   ORBOTO_MCP_TRANSPORT  optional — `stdio` (default) | `http`
 *   ORBOTO_MCP_PORT       optional — port for http transport, default 3100
 *   ORBOTO_MCP_CLIENT     optional — client hint for User-Agent (e.g.
 *                         `claude-desktop`, `cursor`).
 */
import { buildOrbotoMcpServer } from './server.js';
import { OrbotoClient, preflightMcpSession } from './orboto-client.js';
import { bootstrapOAuth } from './oauth-bootstrap.js';

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
    // Local-Proxy mode — one MCP client, one process, one identity. The
    // identity is either a static `orb_*` PAT (service-account fallback) OR,
    // when no key is configured, an OAuth session bootstrapped through the
    // workspace login (ORB-943) so a desktop user never pastes a token. All
    // config read at boot; no per-request auth needed because the only user of
    // this stdio pair is the client that spawned us.
    const baseUrl = requireEnv('ORBOTO_API_URL');
    const apiKey = process.env.ORBOTO_API_KEY;
    const userAgentSuffix = process.env.ORBOTO_MCP_CLIENT;
    const authMode = (process.env.ORBOTO_AUTH ?? (apiKey ? 'pat' : 'oauth')).toLowerCase();

    if (authMode === 'pat' && !apiKey) {
      // eslint-disable-next-line no-console
      console.error('[orboto-mcp] ORBOTO_AUTH=pat requires ORBOTO_API_KEY. Unset it to use OAuth, or provide a key.');
      process.exit(2);
    }

    // clientConfig carries either the PAT or the OAuth token provider; both
    // shapes satisfy OrbotoClientConfig.
    let clientConfig: { baseUrl: string; userAgentSuffix?: string; apiKey?: string; tokenProvider?: Awaited<ReturnType<typeof bootstrapOAuth>> };
    if (authMode === 'oauth') {
      try {
        const tokenProvider = await bootstrapOAuth({ apiBaseUrl: baseUrl });
        clientConfig = { baseUrl, userAgentSuffix, tokenProvider };
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error(`[orboto-mcp] OAuth bootstrap failed: ${(err as Error).message}`);
        process.exit(1);
      }
    } else {
      clientConfig = { baseUrl, userAgentSuffix, apiKey };
    }

    // Preflight BEFORE spinning up the transport — so a
    // mis-configured install fails loudly to stderr instead of
    // silently hanging on stdin waiting for JSON-RPC frames.
    const preflightClient = new OrbotoClient(clientConfig);
    try {
      const { userEmail } = await preflightMcpSession(preflightClient);
      // eslint-disable-next-line no-console
      console.error(`[orboto-mcp] authenticated as ${userEmail} (${authMode}) → ${baseUrl}`);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`[orboto-mcp] ${(err as Error).message}`);
      process.exit(1);
    }

    const server = await buildOrbotoMcpServer(clientConfig);
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
