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
  makeWorkSessionClaimsAddHandler,
  makeWorkSessionClaimsReleaseHandler,
  makeWorkFinishHandler,
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

describe('ORB-1612 - orboto_work_finish', () => {
  it('reports the ticket transition and the completion note', async () => {
    const calls = stub([
      {
        json: {
          session: { ...SESSION, status: 'finished', commitSha: 'deadbeef', commitVerified: false },
          durationMinutes: 23,
          changed: true,
          ticketTransitioned: true,
          ticketStatusCategory: 'done',
          noteCommented: true,
        },
      },
    ]);
    const res = await makeWorkFinishHandler(client)({ sessionId: 'ws1', commitSha: 'deadbeef', targetCategory: 'done' });
    expect(calls[0].url).toContain('/work-sessions/ws1/finish-work');
    expect(calls[0].body).toMatchObject({ commitSha: 'deadbeef', targetCategory: 'done' });
    const text = (res.content[0] as { text: string }).text;
    expect(text).toContain('Booked 23 min');
    expect(text).toContain('attested - pending git verification');
    expect(text).toContain('Ticket moved to done');
    expect(text).toContain('Completion note posted');
    expect((res.structuredContent as { ticketTransitioned: boolean }).ticketTransitioned).toBe(true);
  });

  it('reports a verified commit distinctly from an attested-but-unverified one', async () => {
    stub([
      {
        json: {
          session: { ...SESSION, status: 'finished', commitSha: 'cafebabe', commitVerified: true },
          durationMinutes: 5, changed: true, ticketTransitioned: true, ticketStatusCategory: 'done', noteCommented: true,
        },
      },
    ]);
    const res = await makeWorkFinishHandler(client)({ sessionId: 'ws1', commitSha: 'cafebabe' });
    expect((res.content[0] as { text: string }).text).toContain('verified by git ingestion');
  });

  it('reports a role/outcome that leaves the ticket untouched without treating it as an error', async () => {
    stub([
      {
        json: {
          session: { ...SESSION, role: 'review', status: 'finished' },
          durationMinutes: 10, changed: true, ticketTransitioned: false, ticketStatusCategory: 'todo', noteCommented: true,
        },
      },
    ]);
    const res = await makeWorkFinishHandler(client)({ sessionId: 'ws1' });
    expect(res.isError).toBeUndefined();
    expect((res.content[0] as { text: string }).text).toContain('Ticket left at todo - not transitioned this call.');
  });

  it('treats an idempotent no-op re-run as success with no note', async () => {
    stub([
      {
        json: {
          session: { ...SESSION, status: 'finished' },
          durationMinutes: 0, changed: false, ticketTransitioned: false, ticketStatusCategory: 'done', noteCommented: false,
        },
      },
    ]);
    const res = await makeWorkFinishHandler(client)({ sessionId: 'ws1' });
    expect(res.isError).toBeUndefined();
    const text = (res.content[0] as { text: string }).text;
    expect(text).toContain('Idempotent finish');
    expect(text).toContain('No completion note posted');
  });

  it('surfaces a deliveryModeWarning without failing the call', async () => {
    stub([
      {
        json: {
          session: { ...SESSION, status: 'finished' },
          durationMinutes: 8, changed: true, ticketTransitioned: true, ticketStatusCategory: 'done', noteCommented: true,
          deliveryModeWarning: { code: 'no_commit_linked', message: 'no linked commit' },
        },
      },
    ]);
    const res = await makeWorkFinishHandler(client)({ sessionId: 'ws1' });
    expect(res.isError).toBeUndefined();
    expect((res.content[0] as { text: string }).text).toContain('no linked commit');
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

describe('ORB-1610 - orboto_work_session_start with resourceClaims', () => {
  it('passes resourceClaims + onConflict through and reports queued claims', async () => {
    const calls = stub([
      { json: [PROJ] },
      { json: TICKET },
      {
        json: {
          session: { ...SESSION, resourceClaims: [{ kind: 'path', value: 'src/**', mode: 'write', state: 'waiting' }] },
          reused: false,
          queued: [{ claim: { kind: 'path', value: 'src/**', mode: 'write' }, position: 1, blockedBy: [] }],
        },
      },
    ]);
    const res = await makeWorkSessionStartHandler(client)({
      ticketKey: 'ACME-42',
      resourceClaims: [{ kind: 'path', value: 'src/**', mode: 'write' }],
      onConflict: 'queue',
    });
    const post = calls[calls.length - 1];
    expect(post.body).toMatchObject({
      resourceClaims: [{ kind: 'path', value: 'src/**', mode: 'write' }],
      onConflict: 'queue',
    });
    expect((res.content[0] as { text: string }).text).toContain('Queued');
    expect((res.content[0] as { text: string }).text).toContain('position 1');
  });

  it('surfaces claim conflicts distinctly from a lease conflict on 409', async () => {
    const conflicts = [{
      claim: { kind: 'named', value: 'unity-editor:main', mode: 'write' },
      holders: [{ sessionId: 's2', ticketKey: 'ACME-9', userEmail: 'rival@orboto.test', userFullName: 'Rival Bot', claim: { kind: 'named', value: 'unity-editor:main', mode: 'write' } }],
    }];
    stub([
      { json: [PROJ] },
      { json: TICKET },
      { ok: false, status: 409, text: JSON.stringify({ error: 'held', errorKey: 'errors.work_sessions.claim_conflict', claimConflicts: conflicts }) },
    ]);
    const res = await makeWorkSessionStartHandler(client)({
      ticketKey: 'ACME-42',
      resourceClaims: [{ kind: 'named', value: 'unity-editor:main', mode: 'write' }],
    });
    expect(res.isError).toBe(true);
    const text = (res.content[0] as { text: string }).text;
    expect(text).toContain('Rival Bot');
    expect(text).toContain('unity-editor:main');
    expect((res.structuredContent as { claimConflict: boolean }).claimConflict).toBe(true);
  });
});

describe('ORB-1610 - orboto_work_session_claims_add', () => {
  it('adds claims and reports the granted count', async () => {
    const calls = stub([
      {
        json: {
          session: { ...SESSION, resourceClaims: [{ kind: 'path', value: 'src/a/**', mode: 'write', state: 'granted' }] },
          queued: [],
        },
      },
    ]);
    const res = await makeWorkSessionClaimsAddHandler(client)({
      sessionId: 'ws1',
      claims: [{ kind: 'path', value: 'src/a/**', mode: 'write' }],
    });
    expect(calls[0].url).toContain('/work-sessions/ws1/claims');
    expect(calls[0].method).toBe('POST');
    expect(calls[0].body).toMatchObject({ claims: [{ kind: 'path', value: 'src/a/**', mode: 'write' }] });
    expect((res.content[0] as { text: string }).text).toContain('1 granted claim');
  });

  it('reports queued claims separately from granted ones', async () => {
    stub([
      {
        json: {
          session: { ...SESSION, resourceClaims: [{ kind: 'path', value: 'src/b/**', mode: 'write', state: 'waiting' }] },
          queued: [{ claim: { kind: 'path', value: 'src/b/**', mode: 'write' }, position: 2, blockedBy: [] }],
        },
      },
    ]);
    const res = await makeWorkSessionClaimsAddHandler(client)({
      sessionId: 'ws1',
      claims: [{ kind: 'path', value: 'src/b/**', mode: 'write' }],
      onConflict: 'queue',
    });
    const text = (res.content[0] as { text: string }).text;
    expect(text).toContain('0 granted claim');
    expect(text).toContain('position 2');
  });

  it('surfaces a claim conflict on 409 without adding anything', async () => {
    const conflicts = [{
      claim: { kind: 'path', value: 'src/c.ts', mode: 'write' },
      holders: [{ sessionId: 's2', ticketKey: 'ACME-9', userEmail: null, userFullName: null, claim: { kind: 'path', value: 'src/c.ts', mode: 'write' } }],
    }];
    stub([{ ok: false, status: 409, text: JSON.stringify({ error: 'held', errorKey: 'errors.work_sessions.claim_conflict', claimConflicts: conflicts }) }]);
    const res = await makeWorkSessionClaimsAddHandler(client)({
      sessionId: 'ws1',
      claims: [{ kind: 'path', value: 'src/c.ts', mode: 'write' }],
    });
    expect(res.isError).toBe(true);
    expect((res.content[0] as { text: string }).text).toContain('No claims were added');
  });
});

describe('ORB-1610 - orboto_work_session_claims_release', () => {
  it('releases specific claims and reports the remaining count', async () => {
    const calls = stub([{ text: JSON.stringify({ ...SESSION, resourceClaims: [{ kind: 'path', value: 'src/b/**', mode: 'write', state: 'granted' }] }) }]);
    const res = await makeWorkSessionClaimsReleaseHandler(client)({
      sessionId: 'ws1',
      claims: [{ kind: 'path', value: 'src/a/**' }],
    });
    expect(calls[0].url).toContain('/work-sessions/ws1/claims');
    expect(calls[0].method).toBe('DELETE');
    expect(calls[0].body).toMatchObject({ claims: [{ kind: 'path', value: 'src/a/**' }] });
    expect((res.content[0] as { text: string }).text).toContain('1 claim(s) remain');
  });

  it('releases everything when claims is omitted, and still sends a body', async () => {
    const calls = stub([{ text: JSON.stringify({ ...SESSION, resourceClaims: [] }) }]);
    const res = await makeWorkSessionClaimsReleaseHandler(client)({ sessionId: 'ws1' });
    // A DELETE with a genuinely absent body 400s on the API's schema
    // (ORB-1610 finding) - the handler must always send at least `{}`.
    expect(calls[0].body).toEqual({});
    expect((res.content[0] as { text: string }).text).toContain('Released every claim');
  });
});
