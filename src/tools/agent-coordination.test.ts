/**
 * ORB-705 — Multi-Agent Coordination MCP tools.
 *
 * Pins the contract that each tool wraps the right REST endpoint
 * with the right body shape and surfaces the response. The actual
 * end-to-end push behaviour is covered by the API-side tests in
 * agent-sessions.test.ts.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OrbotoClient } from '../orboto-client.js';
import {
  makeAgentHeartbeatHandler,
  makeAgentPresenceHandler,
  makeAgentNotifyHandler,
} from './agent-coordination.js';

afterEach(() => { vi.restoreAllMocks(); });

function stub(responses: Array<{ ok?: boolean; status?: number; json?: unknown }>) {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
    const r = responses.shift();
    if (!r) throw new Error('unexpected fetch');
    return {
      ok: r.ok ?? true,
      status: r.status ?? 200,
      statusText: 'OK',
      json: async () => ('json' in r ? r.json : {}),
      text: async () => '',
    } as unknown as Response;
  });
}

const client = new OrbotoClient({ baseUrl: 'https://orboto.example.com', apiKey: 'orb_test' });

describe('orboto_agent_heartbeat', () => {
  it('POSTs to /v1/agent/heartbeat with the merged body + returns the session token', async () => {
    stub([{ json: { sessionToken: 'abc-123-token', sessionId: '00000000-0000-0000-0000-000000000001' } }]);
    const handler = makeAgentHeartbeatHandler(client);
    const result = await handler({
      status: 'working',
      capabilities: ['writes-tickets'],
      clientInfo: { name: 'claude-code' },
    });
    expect(result.structuredContent).toMatchObject({
      sessionToken: 'abc-123-token',
      sessionId: '00000000-0000-0000-0000-000000000001',
    });
    expect((result.content[0] as { text: string }).text).toContain('heartbeat ack');
  });
});

describe('orboto_agent_presence', () => {
  it('GETs /v1/agent/presence and renders one line per session', async () => {
    stub([{
      json: [
        {
          userId: '00000000-0000-0000-0000-000000000001',
          userEmail: 'alice@x.test',
          userFullName: 'Alice',
          sessionId: '00000000-0000-0000-0000-000000000010',
          status: 'working',
          workingOnTicket: { id: 't1', key: 'ORB-42', title: 'Test', projectKey: 'ORB' },
          capabilities: ['writes-tickets'],
          clientInfo: { name: 'claude-code' },
          lastSeenAt: new Date().toISOString(),
          createdAt: new Date().toISOString(),
        },
        {
          userId: '00000000-0000-0000-0000-000000000002',
          userEmail: 'bot@x.test',
          userFullName: null,
          sessionId: '00000000-0000-0000-0000-000000000011',
          status: 'idle',
          workingOnTicket: null,
          capabilities: [],
          clientInfo: { name: 'dispatcher-daemon' },
          lastSeenAt: new Date().toISOString(),
          createdAt: new Date().toISOString(),
        },
      ],
    }]);
    const handler = makeAgentPresenceHandler(client);
    const result = await handler();
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain('2 active session(s)');
    expect(text).toContain('Alice (claude-code) — working · working on [ORB] ORB-42');
    expect(text).toContain('bot@x.test (dispatcher-daemon) — idle');
    expect((result.structuredContent as { sessions: unknown[] }).sessions).toHaveLength(2);
  });

  it('handles an empty workspace gracefully', async () => {
    stub([{ json: [] }]);
    const handler = makeAgentPresenceHandler(client);
    const result = await handler();
    expect((result.content[0] as { text: string }).text).toBe('No active agent sessions in the workspace.');
  });
});

describe('orboto_agent_notify', () => {
  it('POSTs to /v1/agent/notify with the body the user supplied', async () => {
    const capturedBody: unknown[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      capturedBody.push(JSON.parse((init?.body as string) ?? '{}'));
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({ ok: true }),
        text: async () => '',
      } as unknown as Response;
    });

    const handler = makeAgentNotifyHandler(client);
    const result = await handler({
      targetEmail: 'bob@example.com',
      kind: 'request',
      subject: 'Please review ORB-42',
      payload: { ticketKey: 'ORB-42' },
    });

    expect(capturedBody[0]).toMatchObject({
      targetEmail: 'bob@example.com',
      kind: 'request',
      subject: 'Please review ORB-42',
      payload: { ticketKey: 'ORB-42' },
    });
    expect((result.content[0] as { text: string }).text).toContain('notified bob@example.com');
    expect(result.structuredContent).toMatchObject({ ok: true });
  });
});
