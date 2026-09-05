/**
 * ORB-1331 - end-to-end transport proof of the session-start nudge.
 *
 * Drives the REAL server (buildOrbotoMcpServer → registerWithMetrics →
 * withMetrics → prependNudge) over an in-memory MCP transport with a
 * genuine MCP Client, so the whole JSON-RPC dispatch path is exercised,
 * not just the helper in isolation.
 *
 * Transport semantics both reduce to the lifetime of the per-build nudge
 * state:
 *   - HTTP: the transport calls buildOrbotoMcpServer once PER SESSION, so
 *     each session is an independent server instance with its own state.
 *   - stdio: buildOrbotoMcpServer is called once PER PROCESS, so a single
 *     server instance's state is process-local.
 * We model a "session"/"process" as one built server + one connected
 * client, and assert the nudge fires exactly once on the first non-
 * session_start call and never when the first call is session_start.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildOrbotoMcpServer } from './server.js';
import { SESSION_START_NUDGE } from './session-nudge.js';

// Every API call the tools make resolves to a benign empty payload so
// the handlers succeed without a live backend. list_projects → [] →
// "no projects" text + valid structuredContent; session_start's sub-
// rules read is required and carries an explicit valid empty ruleset.
function mockApi() {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => ({
    ok: true,
    status: 200,
    statusText: 'OK',
    headers: new Headers({ 'content-type': 'application/json' }),
    json: async () => String(url).includes('/agent-instructions') ? { instructions: '', rulesHash: 'empty', requireSessionStart: false } : [],
    text: async () => '[]',
  } as unknown as Response));
}

beforeEach(() => { vi.restoreAllMocks(); mockApi(); });
afterEach(() => { vi.restoreAllMocks(); });

/** Build a fresh server ("session"/"process") + a connected MCP client. */
async function connectSession(): Promise<Client> {
  const server = await buildOrbotoMcpServer({ baseUrl: 'http://api.invalid', apiKey: 'orb_test' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  return client;
}

/** First text block of a tool result. */
function firstText(res: Awaited<ReturnType<Client['callTool']>>): string {
  const content = res.content as Array<{ type: string; text?: string }>;
  return content[0]?.text ?? '';
}

describe('ORB-1331 - HTTP transport (per-session nudge)', () => {
  it('keeps an unavailable connect policy gated until rules are loaded successfully', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('secret offline'));
    const client = await connectSession();
    try {
      const blocked = await client.callTool({ name: 'orboto_list_projects', arguments: {} });
      expect(blocked.isError).toBe(true);
      const failed = await client.callTool({ name: 'orboto_session_start', arguments: { rulesOnly: true } });
      expect(failed.isError).toBe(true);
      expect(firstText(failed)).not.toContain('secret');
      mockApi();
      const recovered = await client.callTool({ name: 'orboto_session_start', arguments: { rulesOnly: true } });
      expect(recovered.isError).not.toBe(true);
      expect((await client.callTool({ name: 'orboto_list_projects', arguments: {} })).isError).not.toBe(true);
    } finally { await client.close(); }
  });
  it('prepends the nudge exactly once when the first call is orboto_list_projects; the second call is clean', async () => {
    const client = await connectSession();

    const first = await client.callTool({ name: 'orboto_list_projects', arguments: {} });
    expect(firstText(first)).toContain(SESSION_START_NUDGE);
    // structuredContent must be untouched by the text-block prepend.
    expect(first.structuredContent).toMatchObject({ projects: [], total: 0 });

    const second = await client.callTool({ name: 'orboto_list_projects', arguments: {} });
    expect(firstText(second)).not.toContain(SESSION_START_NUDGE);
  });

  it('never nudges a session whose first call is orboto_session_start', async () => {
    const client = await connectSession();

    const first = await client.callTool({ name: 'orboto_session_start', arguments: {} });
    expect(firstText(first)).not.toContain(SESSION_START_NUDGE);

    const second = await client.callTool({ name: 'orboto_list_projects', arguments: {} });
    expect(firstText(second)).not.toContain(SESSION_START_NUDGE);
  });

  it('isolates the nudge per session - a second, independent session nudges on its own first call', async () => {
    const a = await connectSession();
    const b = await connectSession();

    const aFirst = await a.callTool({ name: 'orboto_list_projects', arguments: {} });
    expect(firstText(aFirst)).toContain(SESSION_START_NUDGE);

    // b is a distinct built server → distinct state → still nudges.
    const bFirst = await b.callTool({ name: 'orboto_list_projects', arguments: {} });
    expect(firstText(bFirst)).toContain(SESSION_START_NUDGE);
  });
});

describe('ORB-1331 - stdio transport (process-local nudge)', () => {
  it('fires once for the process: first non-session_start call nudged, all later calls clean', async () => {
    // stdio builds one server per process → one nudge state reused for
    // every call on this single connected client.
    const client = await connectSession();

    const first = await client.callTool({ name: 'orboto_list_projects', arguments: {} });
    expect(firstText(first)).toContain(SESSION_START_NUDGE);

    const second = await client.callTool({ name: 'orboto_session_start', arguments: {} });
    expect(firstText(second)).not.toContain(SESSION_START_NUDGE);

    const third = await client.callTool({ name: 'orboto_list_projects', arguments: {} });
    expect(firstText(third)).not.toContain(SESSION_START_NUDGE);
  });

  it('a process whose first call is session_start never sees the nudge', async () => {
    const client = await connectSession();

    const first = await client.callTool({ name: 'orboto_session_start', arguments: {} });
    expect(firstText(first)).not.toContain(SESSION_START_NUDGE);
  });
});
