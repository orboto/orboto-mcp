/**
 * ORB-1609 - unit tests for the work-session tools.
 *
 * The behaviours worth pinning are the ones an agent's control flow
 * depends on: the 409 must surface the HOLDER (otherwise a colliding
 * agent cannot decide what to do next without another call), and the
 * idempotent finish must read as success rather than as an error.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OrbotoClient } from '../orboto-client.js';
import {
  makeWorkSessionStartHandler,
  makeWorkSessionFinishHandler,
  makeWorkSessionsHandler,
} from './work-sessions.js';

beforeEach(() => { vi.restoreAllMocks(); });
afterEach(() => { vi.restoreAllMocks(); });

function stub(responses: Array<{ ok?: boolean; status?: number; json?: unknown; text?: string }>) {
  const calls: Array<{ url: string; method: string; body?: Record<string, unknown> }> = [];
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
      text: async () => r.text ?? '',
    } as unknown as Response;
  });
  return calls;
}

const client = new OrbotoClient({ baseUrl: 'https://orboto.example.com', apiKey: 'orb_x' });
const PROJ = { id: 'p1', key: 'ACME', name: 'Acme', description: null, status: 'active' };
const TICKET = { id: 't1', ticketKey: 'ACME-42', title: 'Do the thing', projectId: 'p1' };

const SESSION = {
  id: 'ws1',
  ticketId: 't1',
  role: 'implementation',
  status: 'active',
  startedAt: '2026-07-24T10:00:00Z',
  leaseUntil: '2026-07-24T10:15:00Z',
  activeTimerId: 'timer1',
  commitSha: null,
  ticketKey: 'ACME-42',
};

describe('orboto_work_session_start', () => {
  it('acquires the lease and reports the session id + expiry', async () => {
    const calls = stub([
      { json: [PROJ] },
      { json: TICKET },
      { json: { session: SESSION, reused: false } },
    ]);
    const res = await makeWorkSessionStartHandler(client)({ ticketKey: 'ACME-42' });
    const post = calls[calls.length - 1];
    expect(post.method).toBe('POST');
    expect(post.url).toContain('/work-sessions');
    expect(post.body?.ticketId).toBe('t1');
    // The instance token must be sent unprompted - without it the lease has
    // no owner to renew against.
    expect(String(post.body?.agentSessionToken)).toMatch(/^mcp-/);
    const text = (res.content[0] as { text: string }).text;
    expect(text).toContain('Started a implementation work session on ACME-42');
    expect(text).toContain('ws1');
    expect(text).toContain('Timer running.');
    expect((res.structuredContent as { reused: boolean }).reused).toBe(false);
  });

  it('reports a renewal (not a fresh start) when the same instance re-acquires', async () => {
    stub([
      { json: [PROJ] },
      { json: TICKET },
      { json: { session: SESSION, reused: true } },
    ]);
    const res = await makeWorkSessionStartHandler(client)({ ticketKey: 'ACME-42' });
    expect((res.content[0] as { text: string }).text).toContain('Renewed your existing');
  });

  it('surfaces the holder on a 409 instead of throwing', async () => {
    const holder = {
      sessionId: 'other-session',
      userEmail: 'rival@orboto.test',
      userFullName: 'Rival Bot',
      role: 'implementation',
      startedAt: '2026-07-24T09:00:00Z',
      leaseUntil: '2026-07-24T09:15:00Z',
    };
    stub([
      { json: [PROJ] },
      { json: TICKET },
      {
        ok: false,
        status: 409,
        text: JSON.stringify({ error: 'held', errorKey: 'errors.work_sessions.lease_held', holder }),
      },
    ]);
    const res = await makeWorkSessionStartHandler(client)({ ticketKey: 'ACME-42' });
    expect(res.isError).toBe(true);
    const text = (res.content[0] as { text: string }).text;
    expect(text).toContain('Rival Bot');
    expect(text).toContain('takeover=true');
    expect((res.structuredContent as { holder: { sessionId: string } }).holder.sessionId).toBe('other-session');
  });

  it('passes role, lease and takeover through', async () => {
    const calls = stub([
      { json: [PROJ] },
      { json: TICKET },
      { json: { session: { ...SESSION, role: 'review', activeTimerId: null }, reused: false } },
    ]);
    const res = await makeWorkSessionStartHandler(client)({
      ticketKey: 'ACME-42', role: 'review', leaseSeconds: 3600, takeover: true,
    });
    const post = calls[calls.length - 1];
    expect(post.body).toMatchObject({ role: 'review', leaseSeconds: 3600, takeover: true });
    // A review session attaches without booking time by default.
    expect((res.content[0] as { text: string }).text).toContain('No timer started for this role.');
  });
});

describe('orboto_work_session_finish', () => {
  it('reports the booked time and the freed lease', async () => {
    const calls = stub([
      { json: { session: { ...SESSION, status: 'finished' }, durationMinutes: 23, changed: true } },
    ]);
    const res = await makeWorkSessionFinishHandler(client)({
      sessionId: 'ws1', commitSha: 'deadbeef', verification: { build: true, tests: true },
    });
    expect(calls[0].url).toContain('/work-sessions/ws1/finish');
    expect(calls[0].body).toMatchObject({ commitSha: 'deadbeef', verification: { build: true, tests: true } });
    expect((res.content[0] as { text: string }).text).toContain('Booked 23 min');
  });

  it('treats an already-finished session as success, not an error', async () => {
    stub([{ json: { session: { ...SESSION, status: 'finished' }, durationMinutes: 0, changed: false } }]);
    const res = await makeWorkSessionFinishHandler(client)({ sessionId: 'ws1' });
    expect(res.isError).toBeUndefined();
    expect((res.content[0] as { text: string }).text).toContain('Idempotent finish');
  });
});

describe('orboto_work_sessions', () => {
  it('lists the workspace coordination view by default', async () => {
    const calls = stub([{ json: [{ ...SESSION, userFullName: 'Bot One' }] }]);
    const res = await makeWorkSessionsHandler(client)({});
    expect(calls[0].url).toContain('/work-sessions/active');
    expect((res.content[0] as { text: string }).text).toContain('ACME-42 [implementation] Bot One');
  });

  it('scopes to one ticket and can include the closed history', async () => {
    const calls = stub([
      { json: [PROJ] },
      { json: TICKET },
      { json: [] },
    ]);
    const res = await makeWorkSessionsHandler(client)({ ticketKey: 'ACME-42', includeClosed: true });
    expect(calls[2].url).toContain('/tickets/t1/work-sessions?includeClosed=true');
    expect((res.content[0] as { text: string }).text).toContain('none.');
  });

  it('scopes to my own sessions', async () => {
    const calls = stub([{ json: [] }]);
    await makeWorkSessionsHandler(client)({ scope: 'mine' });
    expect(calls[0].url).toContain('/work-sessions/mine');
  });
});
