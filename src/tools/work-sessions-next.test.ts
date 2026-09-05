/**
 * ORB-1613 - unit tests for orboto_work_next, the collision-aware dispatch
 * pull. Unlike orboto_work_start, this tool never resolves a ticket key
 * client-side - the `projectKey` is passed straight through to
 * POST /work-sessions/next, which resolves it server-side. Every test
 * therefore stubs exactly ONE fetch call.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OrbotoClient } from '../orboto-client.js';
import { makeWorkNextHandler } from './work-sessions.js';

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

const RESERVED = {
  session: SESSION,
  reused: false,
  rulesHash: 'abc123',
  rulesUnchanged: false,
  rules: 'Follow the ticket-first rule.',
  primer: { markdown: '# Primer\nProject conventions.', totalTokens: 42 },
  ticket: {
    ticketKey: 'ACME-42',
    title: 'Do the thing',
    description: 'Needs doing.',
    status: 'TODO',
    statusName: 'To Do',
    priority: 'high',
    type: 'task',
  },
  checklists: [],
  dependencies: { blockedBy: [], blocks: [] },
  gitHealth: [],
  siblingSessions: [],
};

describe('orboto_work_next', () => {
  it('reserves the winning candidate and renders the full bundle, sending projectKey straight through', async () => {
    const calls = stub([{ json: { reserved: RESERVED, reason: null, retryAfterSeconds: null, earliestFreeAt: null, candidatesConsidered: 3, landedIdle: [] } }]);
    const res = await makeWorkNextHandler(client)({ projectKey: 'ACME' });

    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe('POST');
    expect(calls[0].url).toContain('/work-sessions/next');
    expect(calls[0].body?.projectKey).toBe('ACME');
    expect(String(calls[0].body?.agentSessionToken)).toMatch(/^mcp-/);

    const text = (res.content[0] as { text: string }).text;
    expect(text).toContain('Reserved ACME-42');
    expect(text).toContain('ws1');
    expect(text).toContain('## Working rules');
    expect(text).toContain('Follow the ticket-first rule.');
    expect(text).toContain('## Project primer');
    expect(text).toContain('## Ticket: ACME-42');
    expect(text).toContain('Needs doing.');
    const structured = res.structuredContent as { reserved: { ticket: { ticketKey: string } } | null; reason: string | null };
    expect(structured.reserved?.ticket.ticketKey).toBe('ACME-42');
    expect(structured.reason).toBeNull();
  });

  it('caches the rules hash across calls and renders "Renewed" on a reused session', async () => {
    const handler = makeWorkNextHandler(client);
    stub([{ json: { reserved: RESERVED, reason: null, retryAfterSeconds: null, earliestFreeAt: null, candidatesConsidered: 1, landedIdle: [] } }]);
    await handler({ projectKey: 'ACME' });

    const calls2 = stub([{
      json: {
        reserved: { ...RESERVED, reused: true, rulesUnchanged: true, rules: undefined },
        reason: null, retryAfterSeconds: null, earliestFreeAt: null, candidatesConsidered: 1, landedIdle: [],
      },
    }]);
    const res2 = await handler({ projectKey: 'ACME' });
    expect(calls2[0].body?.knownRulesHash).toBe('abc123');
    const text2 = (res2.content[0] as { text: string }).text;
    expect(text2).toContain('Unchanged since your last call');
    expect(text2).toContain('not currently in your context');
    expect(text2).toContain('rulesOnly: true');
    expect(text2).not.toContain('keep following what you already loaded');
    expect(text2).toContain('Renewed your existing');
  });

  it('renders a structured empty result with a retry hint (all-leased)', async () => {
    stub([{
      json: {
        reserved: null, reason: 'all-leased', retryAfterSeconds: 420,
        earliestFreeAt: '2026-07-24T10:15:00Z', candidatesConsidered: 4, landedIdle: [],
      },
    }]);
    const res = await makeWorkNextHandler(client)({ projectKey: 'ACME' });
    expect(res.isError).toBeUndefined();
    const text = (res.content[0] as { text: string }).text;
    expect(text).toContain('all-leased');
    expect(text).toContain('Retry in ~420s');
    expect(text).toContain('2026-07-24T10:15:00Z');
    expect(text).toContain('Candidates considered: 4');
    const structured = res.structuredContent as { reserved: null; reason: string; retryAfterSeconds: number };
    expect(structured.reserved).toBeNull();
    expect(structured.reason).toBe('all-leased');
    expect(structured.retryAfterSeconds).toBe(420);
  });

  it('renders "no derivable ETA" when the API found nothing to derive a hint from', async () => {
    stub([{
      json: {
        reserved: null, reason: 'none-matching', retryAfterSeconds: null,
        earliestFreeAt: null, candidatesConsidered: 0, landedIdle: [],
      },
    }]);
    const res = await makeWorkNextHandler(client)({ projectKey: 'ACME' });
    const text = (res.content[0] as { text: string }).text;
    expect(text).toContain('none-matching');
    expect(text).toContain('No derivable ETA');
    expect(text).not.toContain('Retry in');
  });

  it('forwards role, leaseSeconds, and resourceClaims to the API', async () => {
    const calls = stub([{ json: { reserved: RESERVED, reason: null, retryAfterSeconds: null, earliestFreeAt: null, candidatesConsidered: 1, landedIdle: [] } }]);
    await makeWorkNextHandler(client)({
      projectKey: 'ACME',
      role: 'review',
      leaseSeconds: 300,
      resourceClaims: [{ kind: 'path', value: 'src/**', mode: 'write' }],
      onConflict: 'queue',
    });
    expect(calls[0].body?.role).toBe('review');
    expect(calls[0].body?.leaseSeconds).toBe(300);
    expect(calls[0].body?.resourceClaims).toEqual([{ kind: 'path', value: 'src/**', mode: 'write' }]);
    expect(calls[0].body?.onConflict).toBe('queue');
  });
});
