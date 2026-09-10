#!/usr/bin/env node
/**
 * ORB-244 Phase A - entry point for `@orboto/mcp`.
 *
 * @see ORB-943
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
    const baseUrl = requireEnv('ORBOTO_API_URL');
    const apiKey = process.env.ORBOTO_API_KEY;
    const userAgentSuffix = process.env.ORBOTO_MCP_CLIENT;
    const authMode = (process.env.ORBOTO_AUTH ?? (apiKey ? 'pat' : 'oauth')).toLowerCase();

    if (authMode === 'pat' && !apiKey) {
      // eslint-disable-next-line no-console
      console.error('[orboto-mcp] ORBOTO_AUTH=pat requires ORBOTO_API_KEY. Unset it to use OAuth, or provide a key.');
      process.exit(2);
    }

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
    return;
  }

  if (transport === 'http') {
    const port = Number(process.env.ORBOTO_MCP_PORT ?? '3100');
    const baseUrl = requireEnv('ORBOTO_API_URL');
    const { createHttpServer } = await import('./http-transport.js');
    const httpServer = createHttpServer({ baseUrl });
    httpServer.listen(port, () => {
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
