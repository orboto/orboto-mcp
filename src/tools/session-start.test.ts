/**
 * ORB-1093 — session-start composes 4 reads into a re-orientation
 * digest. Assert it hits the right endpoints and folds the rules +
 * in-progress work + timer into the output.
 *
 * ORB-1607 — also covers the rules-hash ack (per-connection cache) and
 * the optional `ticketKey` one-shot bundle.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OrbotoClient } from '../orboto-client.js';
import { makeSessionStartHandler } from './session-start.js';

beforeEach(() => { vi.restoreAllMocks(); });
afterEach(() => { vi.restoreAllMocks(); });

function stubByPath(map: Record<string, unknown>) {
  const calls: string[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
    const u = new URL(url.toString());
    calls.push(u.pathname + u.search);
    const key = Object.keys(map).find((k) => (u.pathname + u.search).startsWith(k));
    return { ok: true, status: 200, statusText: 'OK', json: async () => (key ? map[key] : {}), text: async () => '' } as unknown as Response;
  });
  return calls;
}

/** Like `stubByPath`, but a given path can also 404 (OrbotoApiError). */
function stubByPathWithFailures(map: Record<string, unknown>, notFound: string[]) {
  const calls: string[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
    const u = new URL(url.toString());
    const pathAndSearch = u.pathname + u.search;
    calls.push(pathAndSearch);
    if (notFound.some((p) => pathAndSearch.startsWith(p))) {
      return { ok: false, status: 404, statusText: 'Not Found', json: async () => ({ error: 'not_found' }), text: async () => 'not found' } as unknown as Response;
    }
    const key = Object.keys(map).find((k) => pathAndSearch.startsWith(k));
    return { ok: true, status: 200, statusText: 'OK', json: async () => (key ? map[key] : {}), text: async () => '' } as unknown as Response;
  });
  return calls;
}

const client = new OrbotoClient({ baseUrl: 'https://orboto.example.com', apiKey: 'orb_x' });

describe('orboto_session_start (ORB-1093)', () => {
  it('composes identity + rules + in-progress tickets + timer', async () => {
    const calls = stubByPath({
      '/users/me/assigned-tickets': { items: [{ ticketKey: 'ORB-42', title: 'Wire it up', statusName: 'In Progress' }] },
      '/users/me': { email: 'dev@x.io', fullName: 'Dev', workspaceLocale: 'en' },
      '/agent-instructions': { instructions: 'claim -> commit -> close' },
      '/time/timer': { ticketId: 't1', ticketKey: 'ORB-42', startedAt: '2026-06-15T10:00:00Z' },
    });
    const res = await makeSessionStartHandler(client)();
    const text = (res.content[0] as { text: string }).text;
    expect(text).toContain('claim -> commit -> close');
    expect(text).toContain('ORB-42');
    expect(text).toContain('Running on ORB-42');
    expect(calls.some((c) => c.startsWith('/agent-instructions'))).toBe(true);
    expect(calls.some((c) => c.startsWith('/time/timer'))).toBe(true);
    // ORB-1330 — the briefing must only ask for OPEN work; DONE tickets
    // must never reach the "in-progress" section. Assert the status
    // filter is on the wire so a future refactor can't silently widen it.
    const assignedCall = calls.find((c) => c.startsWith('/users/me/assigned-tickets'));
    expect(assignedCall).toBeDefined();
    expect(assignedCall).toContain('statuses=IN_PROGRESS,IN_REVIEW');
  });

  it('handles the empty case (no tickets, no timer) without throwing', async () => {
    stubByPath({
      '/users/me/assigned-tickets': { items: [] },
      '/users/me': { email: 'dev@x.io', fullName: 'Dev' },
      '/agent-instructions': { instructions: 'rules here' },
      '/time/timer': {},
    });
    const res = await makeSessionStartHandler(client)();
    const text = (res.content[0] as { text: string }).text;
    expect(text).toContain('No tickets currently assigned');
    expect(text).toContain('No timer running');
  });

  // ORB-1605 — session-start fans out to GET /projects/:id/git-health for
  // every distinct project the caller has open work in, and surfaces a
  // warning when a connection is unhealthy.
  it('warns when a project git connection is unhealthy', async () => {
    stubByPath({
      '/users/me/assigned-tickets': {
        items: [{ ticketKey: 'ORB-42', title: 'Wire it up', statusName: 'In Review', projectId: 'proj-1' }],
      },
      '/users/me': { email: 'dev@x.io', fullName: 'Dev' },
      '/agent-instructions': { instructions: 'rules here' },
      '/time/timer': {},
      '/projects/proj-1/git-health': {
        connections: [{
          connectionId: 'conn-1', name: 'orboto/orboto', provider: 'github',
          connected: false, healthy: false, lastEventAt: null, reason: 'connection_inactive',
        }],
      },
    });
    const res = await makeSessionStartHandler(client)();
    const text = (res.content[0] as { text: string }).text;
    expect(text).toContain('Git connection health — WARNING');
    expect(text).toContain('orboto/orboto');
    expect(text).toContain('connection is deactivated');
    // ORB-1697 - unhealthy connections only; a healthy one is 11 fields
    // the agent never acts on, so it is reduced to a count.
    const structured = res.structuredContent as {
      gitHealth: { unhealthy: Array<{ projectId: string; connections: unknown[] }>; healthyCount: number };
    };
    expect(structured.gitHealth.unhealthy).toHaveLength(1);
    expect(structured.gitHealth.unhealthy[0].projectId).toBe('proj-1');
    expect(structured.gitHealth.healthyCount).toBe(0);
  });

  it('omits the git health section when every connection is healthy', async () => {
    stubByPath({
      '/users/me/assigned-tickets': {
        items: [{ ticketKey: 'ORB-42', title: 'Wire it up', statusName: 'In Review', projectId: 'proj-1' }],
      },
      '/users/me': { email: 'dev@x.io', fullName: 'Dev' },
      '/agent-instructions': { instructions: 'rules here' },
      '/time/timer': {},
      '/projects/proj-1/git-health': {
        connections: [{
          connectionId: 'conn-1', name: 'orboto/orboto', provider: 'github',
          connected: true, healthy: true, lastEventAt: '2026-07-20T00:00:00Z', reason: null,
        }],
      },
    });
    const res = await makeSessionStartHandler(client)();
    const text = (res.content[0] as { text: string }).text;
    expect(text).not.toContain('Git connection health — WARNING');
  });
});

// ORB-1607 — rules-hash ack: the handler remembers the last rulesHash it
// saw FOR THE LIFETIME OF ONE `makeSessionStartHandler(client)` CLOSURE
// (mirrors one MCP connection) and passes it back as `knownRulesHash` on
// every subsequent call.
describe('orboto_session_start — rules-hash ack (ORB-1607)', () => {
  it('sends no knownRulesHash on the first call, then passes the received hash back on the second', async () => {
    const calls: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      const u = new URL(url.toString());
      calls.push(u.pathname + u.search);
      if (u.pathname === '/agent-instructions') {
        const known = u.searchParams.get('knownRulesHash');
        const body = known === 'abc123def456'
          ? { rulesHash: 'abc123def456', rulesUnchanged: true }
          : { instructions: 'claim -> commit -> close', rulesHash: 'abc123def456' };
        return { ok: true, status: 200, statusText: 'OK', json: async () => body, text: async () => '' } as unknown as Response;
      }
      const fallback: Record<string, unknown> = {
        '/users/me/assigned-tickets': { items: [] },
        '/users/me': { email: 'dev@x.io', fullName: 'Dev' },
        '/time/timer': {},
      };
      const key = Object.keys(fallback).find((k) => (u.pathname + u.search).startsWith(k));
      return { ok: true, status: 200, statusText: 'OK', json: async () => (key ? fallback[key] : {}), text: async () => '' } as unknown as Response;
    });

    const handler = makeSessionStartHandler(client);

    const first = await handler();
    const firstCall = calls.find((c) => c.startsWith('/agent-instructions'));
    expect(firstCall).toBe('/agent-instructions');
    const firstText = (first.content[0] as { text: string }).text;
    expect(firstText).toContain('claim -> commit -> close');
    const firstStructured = first.structuredContent as { rulesHash: string | null; rulesUnchanged: boolean };
    expect(firstStructured.rulesHash).toBe('abc123def456');
    expect(firstStructured.rulesUnchanged).toBe(false);

    calls.length = 0;
    const second = await handler();
    const secondCall = calls.find((c) => c.startsWith('/agent-instructions'));
    expect(secondCall).toBe('/agent-instructions?knownRulesHash=abc123def456');
    const secondText = (second.content[0] as { text: string }).text;
    // ORB-1697 - the ack must not assert that the CALLER still holds the
    // rules (a stdio server outlives /clear and every compaction), and it
    // must name the way to get them back.
    expect(secondText).toContain('Unchanged since this connection last delivered them');
    expect(secondText).toContain('forceRules=true');
    expect(secondText).not.toContain('keep following what you already loaded');
    expect(secondText).not.toContain('claim -> commit -> close');
    const secondStructured = second.structuredContent as { rulesHash: string | null; rulesUnchanged: boolean };
    expect(secondStructured.rulesHash).toBe('abc123def456');
    expect(secondStructured.rulesUnchanged).toBe(true);
  });

  it('a fresh handler (new connection) starts with no cached hash again', async () => {
    const calls = stubByPath({
      '/users/me/assigned-tickets': { items: [] },
      '/users/me': { email: 'dev@x.io', fullName: 'Dev' },
      '/agent-instructions': { instructions: 'rules here', rulesHash: 'hash1' },
      '/time/timer': {},
    });
    await makeSessionStartHandler(client)();
    const call = calls.find((c) => c.startsWith('/agent-instructions'));
    expect(call).toBe('/agent-instructions');
  });
});

// ORB-1607 — the optional `ticketKey` one-shot bundle: project primer,
// full ticket (incl. dependencies + checklists), git health, and active
// sessions folded into the same response.
describe('orboto_session_start — ticketKey bundle (ORB-1607)', () => {
  const bundleStubs = {
    '/projects/by-key/ORB': { id: 'proj-1', key: 'ORB', name: 'orboto' },
    '/projects/proj-1/tickets/by-key/42': { id: 'tick-1', projectId: 'proj-1', ticketKey: 'ORB-42', title: 'Bug', status: 'IN_PROGRESS' },
    '/projects/proj-1/tickets/tick-1/dependencies': {
      blockedBy: [{ ticketKey: 'ORB-10', title: 'Prereq', statusName: 'Done', statusCategory: 'done' }],
      blocks: [],
    },
    '/tickets/tick-1/checklists': [{
      title: 'Acceptance', triggersDone: true, progress: { done: 1, total: 2 },
      items: [
        { content: 'Write tests', effectiveCompleted: true, linkedTicketKey: null, linkedTicketTitle: null, linkedTicketStatusCategory: null },
        { content: 'Update docs', effectiveCompleted: false, linkedTicketKey: null, linkedTicketTitle: null, linkedTicketStatusCategory: null },
      ],
    }],
    '/projects/proj-1/ai-primer': { markdown: '# orboto primer\n\nActive milestones: 2', totalTokens: 42, truncatedSections: [] },
    '/projects/proj-1/git-health': { connections: [] },
    '/v1/agent/presence': [{ userId: 'u2', userEmail: 'other@x.io', userFullName: 'Other Dev', status: 'working', workingOnTicket: { id: 'tick-1', key: 'ORB-42', title: 'Bug' }, lastSeenAt: '2026-07-23T10:00:00Z' }],
  };
  const baseStubs = {
    '/users/me/assigned-tickets': { items: [] },
    '/users/me': { email: 'dev@x.io', fullName: 'Dev' },
    '/agent-instructions': { instructions: 'rules here', rulesHash: 'h1' },
    '/time/timer': {},
    // Re-fetch of the enriched by-id row (mirrors orboto_get_ticket).
    '/projects/proj-1/tickets/tick-1': {
      id: 'tick-1', projectId: 'proj-1', ticketKey: 'ORB-42', title: 'Bug',
      status: 'IN_PROGRESS', statusName: 'In Progress', priority: 'high', type: 'bug',
      description: 'Something is broken.',
    },
  };

  it('folds primer + ticket + dependencies + checklists + git health + active sessions into one response', async () => {
    // bundleStubs first — the merged map is matched by `startsWith`, and
    // baseStubs' bare `/projects/proj-1/tickets/tick-1` would otherwise
    // shadow bundleStubs' longer `/projects/proj-1/tickets/tick-1/dependencies`
    // if it came first in iteration order.
    const calls = stubByPath({ ...bundleStubs, ...baseStubs });
    const res = await makeSessionStartHandler(client)({ ticketKey: 'ORB-42' });
    const text = (res.content[0] as { text: string }).text;

    expect(text).toContain('## Ticket bundle: ORB-42');
    expect(text).toContain('orboto primer');
    expect(text).toContain('[ORB-42] Bug');
    expect(text).toContain('Something is broken.');
    expect(text).toContain('Write tests');
    expect(text).toContain('[ORB-10] Prereq');
    expect(text).toContain('Other Dev');

    const structured = res.structuredContent as { ticketBundle: { ticketKey: string; checklists: unknown[]; dependencies: { blockedBy: unknown[] }; activeSessions: unknown[] } };
    expect(structured.ticketBundle.ticketKey).toBe('ORB-42');
    expect(structured.ticketBundle.checklists).toHaveLength(1);
    expect(structured.ticketBundle.dependencies.blockedBy).toHaveLength(1);
    expect(structured.ticketBundle.activeSessions).toHaveLength(1);

    // Replaces what would otherwise be several separate calls.
    expect(calls.some((c) => c.startsWith('/projects/proj-1/ai-primer'))).toBe(true);
    expect(calls.some((c) => c.startsWith('/tickets/tick-1/checklists'))).toBe(true);
    expect(calls.some((c) => c.startsWith('/projects/proj-1/tickets/tick-1/dependencies'))).toBe(true);
  });

  it('an unresolvable/unauthorized ticket key surfaces a clean error section instead of throwing', async () => {
    stubByPathWithFailures(
      { ...baseStubs, '/projects/by-key/ORB': { id: 'proj-1', key: 'ORB', name: 'orboto' } },
      ['/projects/proj-1/tickets/by-key/999'],
    );
    const res = await makeSessionStartHandler(client)({ ticketKey: 'ORB-999' });
    const text = (res.content[0] as { text: string }).text;
    expect(text).toContain('## Ticket bundle: ORB-999');
    expect(text).toContain('Could not load this ticket');
    // The rest of the digest (rules, in-progress work, timer) still renders.
    expect(text).toContain('## Working rules');
    expect(text).toContain('## Timer');
    const structured = res.structuredContent as { ticketBundle: { error: string } };
    expect(structured.ticketBundle.error).toBeTruthy();
  });
});

/**
 * ORB-1697 - the response-budget-driven changes to session_start.
 *
 * The digest is the most expensive tool in the workspace (measured 18.620
 * characters average, fired on every session start AND after every
 * compaction), so what it puts in the payload has to earn its place.
 */
describe('orboto_session_start - context cost (ORB-1697)', () => {
  const client = new OrbotoClient({ baseUrl: 'http://api.test', apiKey: 'orb_k' });

  const rulesStub = {
    '/users/me/assigned-tickets': { items: [] },
    '/users/me': { email: 'dev@x.io', fullName: 'Dev' },
    '/agent-instructions': { instructions: 'THE FULL RULE TEXT', rulesHash: 'h9' },
    '/time/timer': {},
  };

  it('forceRules re-sends the rules in full even when this connection already delivered them', async () => {
    const calls = stubByPath(rulesStub);
    const handler = makeSessionStartHandler(client);

    await handler();                       // primes the per-connection hash
    calls.length = 0;
    const forced = await handler({ forceRules: true });

    // No knownRulesHash means the API cannot answer with an ack.
    expect(calls.find((c) => c.startsWith('/agent-instructions'))).toBe('/agent-instructions');
    const text = (forced.content[0] as { text: string }).text;
    expect(text).toContain('THE FULL RULE TEXT');
    expect(text).not.toContain('forceRules=true');
  });

  it('without forceRules the ack path is still used - the saving is not lost', async () => {
    const calls = stubByPath(rulesStub);
    const handler = makeSessionStartHandler(client);
    await handler();
    calls.length = 0;
    await handler();
    expect(calls.find((c) => c.startsWith('/agent-instructions'))).toBe('/agent-instructions?knownRulesHash=h9');
  });

  it('a healthy git connection costs a count, not eleven fields', async () => {
    stubByPath({
      '/users/me/assigned-tickets': {
        items: [{ ticketKey: 'ORB-42', title: 'Wire it up', statusName: 'In Review', projectId: 'proj-1' }],
      },
      '/users/me': { email: 'dev@x.io', fullName: 'Dev' },
      '/agent-instructions': { instructions: 'rules here' },
      '/time/timer': {},
      '/projects/proj-1/git-health': {
        connections: [{
          connectionId: 'conn-1', name: 'orboto/orboto', provider: 'github',
          connected: true, healthy: true, lastEventAt: '2026-08-09T00:00:00Z', reason: null,
          outboundReachable: true, inboundDelivering: true, deliveryError: null, lastProbeAt: '2026-08-09T00:00:00Z',
        }],
      },
    });
    const res = await makeSessionStartHandler(client)();
    const structured = res.structuredContent as { gitHealth: { unhealthy: unknown[]; healthyCount: number } };
    expect(structured.gitHealth.unhealthy).toEqual([]);
    expect(structured.gitHealth.healthyCount).toBe(1);
    // And the connection object itself is nowhere in the payload.
    expect(JSON.stringify(structured)).not.toContain('lastProbeAt');
  });

  it('with a ticketKey, open work in OTHER projects becomes a count instead of 20 rows', async () => {
    stubByPath({
      '/projects/by-key/ORB': { id: 'proj-1', key: 'ORB', name: 'orboto' },
      '/projects/proj-1/tickets/by-key/42': { id: 'tick-1', projectId: 'proj-1', ticketKey: 'ORB-42', title: 'Bug' },
      '/projects/proj-1/tickets/tick-1': {
        id: 'tick-1', projectId: 'proj-1', ticketKey: 'ORB-42', title: 'Bug',
        status: 'IN_PROGRESS', statusName: 'In Progress', priority: 'high', type: 'bug',
      },
      // Longest path first - the stub map is matched by startsWith.
      '/users/me/assigned-tickets': {
        items: [
          { ticketKey: 'ORB-42', title: 'Same project', statusName: 'In Progress', projectId: 'proj-1' },
          { ticketKey: 'HIVE-818', title: 'Another project entirely', statusName: 'In Progress', projectId: 'proj-2' },
          { ticketKey: 'HIVE-814', title: 'And another', statusName: 'In Review', projectId: 'proj-2' },
        ],
      },
      '/users/me': { email: 'dev@x.io', fullName: 'Dev' },
      '/agent-instructions': { instructions: 'rules here' },
      '/time/timer': {},
      '/v1/agent/presence': [],
    });
    const res = await makeSessionStartHandler(client)({ ticketKey: 'ORB-42' });
    const structured = res.structuredContent as {
      inProgress: Array<{ ticketKey: string }>;
      inProgressElsewhereCount?: number;
    };
    expect(structured.inProgress.map((t) => t.ticketKey)).toEqual(['ORB-42']);
    expect(structured.inProgressElsewhereCount).toBe(2);
    const text = (res.content[0] as { text: string }).text;
    // Nothing is hidden: the count is stated, with the way to list them.
    expect(text).toContain('2 open ticket(s) assigned to you in other projects');
    expect(text).toContain('orboto_my_tickets');
    expect(text).not.toContain('Another project entirely');
  });

  it('without a ticketKey the full cross-project list is kept - the scoping is opt-in by context, not a silent filter', async () => {
    stubByPath({
      '/users/me/assigned-tickets': {
        items: [
          { ticketKey: 'ORB-42', title: 'One', statusName: 'In Progress', projectId: 'proj-1' },
          { ticketKey: 'HIVE-818', title: 'Two', statusName: 'In Progress', projectId: 'proj-2' },
        ],
      },
      '/users/me': { email: 'dev@x.io', fullName: 'Dev' },
      '/agent-instructions': { instructions: 'rules here' },
      '/time/timer': {},
    });
    const res = await makeSessionStartHandler(client)();
    const structured = res.structuredContent as {
      inProgress: Array<{ ticketKey: string }>;
      inProgressElsewhereCount?: number;
    };
    expect(structured.inProgress.map((t) => t.ticketKey)).toEqual(['ORB-42', 'HIVE-818']);
    expect(structured.inProgressElsewhereCount).toBeUndefined();
  });
});

/**
 * ORB-1697 - the class the ORB-1697 tests kept tripping over: every
 * optional read here is guarded with `.catch`, which covers a REJECTED
 * request but not a 200 whose body has a different shape (an older
 * instance, a wrapped/paginated response, a field rename). Three separate
 * spots in this file would have thrown and taken the whole digest down
 * over an optional section - at exactly the moment an agent has the least
 * context. One test pins all of them.
 */
describe('orboto_session_start - a 200 with an unexpected body never kills the digest (ORB-1697)', () => {
  const client = new OrbotoClient({ baseUrl: 'http://api.test', apiKey: 'orb_k' });

  it('renders the digest when every optional endpoint answers 200 with {}', async () => {
    // Only the paths the digest cannot work without return real data; every
    // optional read answers `{}`, which is what the fallthrough produces.
    stubByPath({
      '/projects/by-key/ORB': { id: 'proj-1', key: 'ORB', name: 'orboto' },
      '/projects/proj-1/tickets/by-key/42': { id: 'tick-1', projectId: 'proj-1', ticketKey: 'ORB-42', title: 'Bug' },
      '/users/me/assigned-tickets': { items: [] },
      '/users/me': { email: 'dev@x.io', fullName: 'Dev' },
      '/agent-instructions': { instructions: 'rules here' },
    });

    const res = await makeSessionStartHandler(client)({ ticketKey: 'ORB-42' });

    const text = (res.content[0] as { text: string }).text;
    expect(res.isError).toBeUndefined();
    expect(text).toContain('## Working rules');
    expect(text).toContain('## Ticket bundle: ORB-42');
    expect(text).toContain('### Dependencies');
    expect(text).toContain('### Checklists');
    const structured = res.structuredContent as {
      ticketBundle: { dependencies: { blockedBy: unknown[]; blocks: unknown[] }; checklists: unknown[]; activeSessions: unknown[] };
    };
    expect(structured.ticketBundle.dependencies.blockedBy).toEqual([]);
    expect(structured.ticketBundle.dependencies.blocks).toEqual([]);
    expect(structured.ticketBundle.checklists).toEqual([]);
    expect(structured.ticketBundle.activeSessions).toEqual([]);
  });
});
