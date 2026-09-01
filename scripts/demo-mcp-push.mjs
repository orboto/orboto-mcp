#!/usr/bin/env node
/**
 * Runnable proof that the live-push path works.
 *
 * Subscribes to a single ticket via the deployed `/mcp` endpoint,
 * registers a notification handler, then idles waiting for pushes.
 * Change the ticket in the web UI and watch this script print a line.
 *
 * Why this exists: Claude Desktop / ChatGPT / Claude.ai are turn-based
 * and never react to between-turn pushes; the unit tests cover the
 * bridge with a mocked SSE stream but not the deployed HTTP path. This
 * is the canonical e2e demo for operators and the marketing team's
 * "look it actually works" video.
 *
 * Usage (run via pnpm so the workspace's SDK resolves):
 *   pnpm --filter @orboto/mcp exec node scripts/demo-mcp-push.mjs \
 *     --url https://orboto.example.com/mcp \
 *     --token orb_… \
 *     --ticket ACME-42
 *
 * Both `orb_*` API keys AND OAuth-issued access tokens (JWT) work.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ResourceUpdatedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i += 2) {
    const key = argv[i];
    const value = argv[i + 1];
    if (!key?.startsWith('--')) continue;
    out[key.slice(2)] = value;
  }
  return out;
}

function usage(reason) {
  if (reason) console.error(`error: ${reason}\n`);
  console.error(`usage: pnpm --filter @orboto/mcp exec node scripts/demo-mcp-push.mjs --url <mcp-url> --token <orb_*|oauth-jwt> --ticket <KEY>

example:
  pnpm --filter @orboto/mcp exec node scripts/demo-mcp-push.mjs \\
    --url https://orboto.example.com/mcp \\
    --token orb_… \\
    --ticket ACME-42

Subscribes to orboto://ticket/<KEY> and prints every push that lands.
Ctrl-C to exit.
`);
  process.exit(2);
}

const args = parseArgs(process.argv);
if (!args.url) usage('--url required');
if (!args.token) usage('--token required');
if (!args.ticket) usage('--ticket required');

const uri = `orboto://ticket/${args.ticket}`;

const transport = new StreamableHTTPClientTransport(new URL(args.url), {
  requestInit: {
    headers: { Authorization: `Bearer ${args.token}` },
  },
});

const client = new Client(
  { name: 'orboto-mcp-push-demo', version: '1.0.0' },
  { capabilities: { resources: { subscribe: true } } },
);

// Print every notifications/resources/updated frame the server pushes.
// The SDK's notification handler is keyed by the spec'd schema; URI
// is in `params.uri`. Timestamp from this side so the operator can
// see end-to-end latency vs the web-UI click.
client.setNotificationHandler(ResourceUpdatedNotificationSchema, async (n) => {
  const ts = new Date().toISOString();
  console.log(`[${ts}] PUSH ${n.params.uri}`);
});

await client.connect(transport);
console.log(`connected to ${args.url}`);

await client.subscribeResource({ uri });
console.log(`subscribed to ${uri}`);
console.log(`change the ticket in the web UI - pushes will print below. Ctrl-C to exit.`);

// SIGINT closes cleanly so the server's per-session state gets freed
// (otherwise the bridge sits idle until the OS reaps the connection).
process.on('SIGINT', async () => {
  console.log('\nclosing…');
  try { await client.close(); } catch { /* ignore */ }
  process.exit(0);
});

// Keep the event loop alive. The SDK's transport already pumps the
// SSE stream; we just need to not exit.
await new Promise(() => { /* forever */ });
