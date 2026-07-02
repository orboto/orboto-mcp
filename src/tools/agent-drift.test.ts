/**
 * ORB-543 / ORB-1344 — unit tests for the agent-drift admin MCP tools.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OrbotoApiError, OrbotoClient } from '../orboto-client.js';
import { makeListAgentDriftHandler, makeResolveAgentDriftHandler } from './agent-drift.js';

beforeEach(() => { vi.restoreAllMocks(); });
afterEach(() => { vi.restoreAllMocks(); });

function stub(responses: Array<{ ok?: boolean; status?: number; json?: unknown }>) {
  const calls: Array<{ url: string; method: string; body?: unknown }> = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    calls.push({
      url: url.toString(),
      method: init?.method ?? 'GET',
      body: init?.body ? JSON.parse(init.body as string) : undefined,
    });
    const r = responses.shift();
    if (!r) throw new Error('unexpected extra fetch');
    return {
      ok: r.ok ?? true,
      status: r.status ?? 200,
      statusText: 'OK',
      json: async () => ('json' in r ? r.json : {}),
      text: async () => '',
    } as unknown as Response;
  });
  return calls;
}

const client = new OrbotoClient({ baseUrl: 'https://orboto.example.com', apiKey: 'orb_x' });

const EVENT = {
  id: '11111111-1111-1111-1111-111111111111',
  userId: '22222222-2222-2222-2222-222222222222',
  userName: 'Claude Bot', userEmail: 'claude@orboto.io', userIsBot: true,
  projectId: '33333333-3333-3333-3333-333333333333', projectKey: 'ORB',
  driftType: 'untracked_commit' as const,
  commitSha: 'deadbeefcafe', repoUrl: 'https://github.com/x/y', commitMessage: 'wip',
  pushId: 'abc', ticketId: null, ticketKey: null,
  detectedAt: '2026-07-02T10:00:00.000Z', resolvedAt: null,
  retroTicketId: null, retroTicketKey: null,
};

describe('orboto_admin_agent_drift_list', () => {
  it('renders events + metrics and forwards filters to the querystring', async () => {
    const calls = stub([
      { json: { items: [EVENT], nextCursor: 'cur1', metrics: { total: 1, byType: { untracked_commit: 1 }, byUser: [] }, enabled: true } },
    ]);
    const res = await makeListAgentDriftHandler(client)({
      userId: EVENT.userId, driftType: 'untracked_commit', resolved: false, limit: 10,
    });
    expect(calls[0].url).toContain('/admin/agent-drift?');
    expect(calls[0].url).toContain('userId=22222222');
    expect(calls[0].url).toContain('driftType=untracked_commit');
    expect(calls[0].url).toContain('resolved=false');
    expect(calls[0].url).toContain('limit=10');
    const text = res.content[0].type === 'text' ? res.content[0].text : '';
    expect(text).toContain('untracked_commit');
    expect(text).toContain('Claude Bot');
    expect(text).toContain('next cursor: cur1');
  });

  it('flags a disabled workspace in the header', async () => {
    stub([
      { json: { items: [], nextCursor: null, metrics: { total: 0, byType: {}, byUser: [] }, enabled: false } },
    ]);
    const res = await makeListAgentDriftHandler(client)({});
    const text = res.content[0].type === 'text' ? res.content[0].text : '';
    expect(text).toMatch(/DISABLED/);
    expect(text).toContain('(no drift events)');
  });

  it('surfaces a 403 as an OrbotoApiError', async () => {
    stub([{ ok: false, status: 403, json: { error: 'Forbidden' } }]);
    await expect(makeListAgentDriftHandler(client)({})).rejects.toBeInstanceOf(OrbotoApiError);
  });
});

describe('orboto_admin_agent_drift_resolve', () => {
  it('POSTs to the resolve endpoint', async () => {
    const calls = stub([{ json: { id: EVENT.id, resolvedAt: '2026-07-02T11:00:00.000Z' } }]);
    const res = await makeResolveAgentDriftHandler(client)({ id: EVENT.id });
    expect(calls[0].method).toBe('POST');
    expect(calls[0].url).toContain(`/admin/agent-drift/${EVENT.id}/resolve`);
    const text = res.content[0].type === 'text' ? res.content[0].text : '';
    expect(text).toContain('Resolved drift event');
  });

  it('surfaces a 404 as an OrbotoApiError', async () => {
    stub([{ ok: false, status: 404, json: { error: 'Drift event not found' } }]);
    await expect(makeResolveAgentDriftHandler(client)({ id: EVENT.id })).rejects.toBeInstanceOf(OrbotoApiError);
  });
});
