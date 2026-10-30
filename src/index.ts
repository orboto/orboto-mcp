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

    const { channelStartFromEnv } = await import('./channel-start.js');
    const channelStart = channelStartFromEnv({
      ORBOTO_MCP_CHANNEL: process.env.ORBOTO_MCP_CHANNEL, ORBOTO_CLAUDE_CHANNEL: process.env.ORBOTO_CLAUDE_CHANNEL,
      ORBOTO_ORIGIN: process.env.ORBOTO_ORIGIN, ORBOTO_MCP_CLI_OUTDATED: process.env.ORBOTO_MCP_CLI_OUTDATED,
    });
    const channel = channelStart !== null;
    const server = await buildOrbotoMcpServer({ ...clientConfig, channel, instanceToken: (await import('./tools/shared.js')).mcpProcessInstance() });
    const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js');
    const stdio = new StdioServerTransport();
    await server.connect(stdio);
    const { releaseCapacityOnStdinEnd } = await import('./tools/capacity-session.js');
    const releaseCapacity = releaseCapacityOnStdinEnd(process.stdin, preflightClient, (await import('./tools/shared.js')).mcpProcessInstance());
    if (channel) {
      const { InboxChannel, digestMinutesFromEnv, cliOutdatedNotice, CLI_OUTDATED_NOTICE } = await import('./inbox-channel.js');
      const { mcpProcessInstance, adoptJoined } = await import('./tools/shared.js');
      let instanceToken = mcpProcessInstance();
      const { declareEnvProjectScope } = await import('./project-scope.js');
      const declared = await declareEnvProjectScope(preflightClient, instanceToken);
      const inbox = new InboxChannel({ ...clientConfig, instanceToken, mcp: server, digestMinutes: digestMinutesFromEnv(process.env.ORBOTO_MCP_CHANNEL_DIGEST_MINUTES) });
      inbox.start();
      if (declared?.refusal) void inbox.deliverNotice('session_exists', declared.refusal);
      const outdated = cliOutdatedNotice(process.env.ORBOTO_MCP_CLI_OUTDATED);
      if (outdated) void inbox.deliverNotice(CLI_OUTDATED_NOTICE, outdated);
      const { readClaudeReport, channelClientInfo, unsentSamples, newestSample } = await import('./claude-context.js');
      const { presenceRefusal } = await import('./tools/shared.js');
      const { checkoutRepository } = await import('./checkout-repository.js');
      const repository = checkoutRepository();
      let refusalLogged = false;
      let samplesSentUpTo: number | null = null;
      const beat = () => {
        const report = readClaudeReport(process.cwd());
        const usageSamples = unsentSamples(report?.usageSamples ?? [], samplesSentUpTo);
        preflightClient.post<{ joined?: { instanceToken?: string } }>('/v1/agent/heartbeat', { clientInfo: channelClientInfo(report?.context ?? null, undefined, channelStart ?? undefined), ...(repository ? { repository } : {}), ...(usageSamples.length ? { usageSamples } : {}) }, { instanceToken })
          .then((res) => {
            refusalLogged = false;
            samplesSentUpTo = newestSample(usageSamples, samplesSentUpTo);
            const joined = adoptJoined(res);
            if (joined) {
              instanceToken = joined;
              inbox.switchInstance(joined);
            }
          })
          .catch((err) => {
            const refused = presenceRefusal(err);
            if (refused && refusalLogged) return;
            refusalLogged = Boolean(refused);
            console.error(`[orboto-mcp] channel heartbeat ${refused ? 'refused' : 'failed'}: ${refused?.message ?? (err as Error).message}`);
          });
      };
      beat();
      const beats = setInterval(beat, 60_000);
      beats.unref?.();
      const cleanup = () => { clearInterval(beats); inbox.close(); };
      stdio.onclose = cleanup;
      const { endProbeSessionOnStdinEnd } = await import('./probe-session.js');
      endProbeSessionOnStdinEnd({ env: process.env, stdin: process.stdin, client: preflightClient, instanceToken, cleanup, exit: (code) => process.exit(code), settle: releaseCapacity });
    } else {
      const { toolServerHeartbeat } = await import('./claude-context.js');
      const { beatAsToolServer } = await import('./tools/shared.js');
      const { checkoutRepository } = await import('./checkout-repository.js');
      beatAsToolServer(preflightClient, toolServerHeartbeat(), checkoutRepository())
        .catch((err) => { console.error(`[orboto-mcp] heartbeat failed: ${(err as Error).message}`); });
    }
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
