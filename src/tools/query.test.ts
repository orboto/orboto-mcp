/**
 * ORB-273 Phase F - `orboto_query` MCP tool tests.
 *
 * Confirms the handler:
 *   - posts to /query with the right body shape
 *   - emits a human-readable text block + structured-content envelope
 *   - surfaces nextCursor + a "more pages" hint
 *   - propagates the syntax flag (jql vs oql) verbatim
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { OrbotoClient } from '../orboto-client.js';
import { makeQueryHandler } from './query.js';

beforeEach(() => { vi.restoreAllMocks(); });
afterEach(() => { vi.restoreAllMocks(); });

function mockFetch(json: unknown) {
  return vi.spyOn(globalThis, 'fetch').mockResolvedValue({
    ok: true, status: 200, statusText: 'OK',
    json: async () => json,
  } as unknown as Response);
}

describe('tools/query', () => {
  const client = new OrbotoClient({ baseUrl: 'https://orboto.example.com', apiKey: 'orb_test' });

  it('renders matched tickets + structured payload', async () => {
    const spy = mockFetch({
      items: [
        {
          id: 't1',
          ticketKey: 'ORB-1',
          title: 'Fix the bug',
          status: 'IN_PROGRESS',
          statusName: 'In Progress',
          statusCategory: 'in_progress',
          priority: 'high',
          type: 'bug',
          dueDate: '2026-05-10',
          estimatedTimeMinutes: 60,
          loggedMinutes: 15,
          assignees: [{ email: 'a@example.com' }],
          labels: [{ name: 'frontend' }],
        },
      ],
      nextCursor: null,
    });

    const result = await makeQueryHandler(client)({ oql: 'project = ORB' });

    expect(spy).toHaveBeenCalledWith(
      'https://orboto.example.com/query',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ oql: 'project = ORB', syntax: 'oql', cursor: undefined, limit: 25 }),
      }),
    );
    expect(result.content[0]).toMatchObject({ type: 'text', text: expect.stringContaining('ORB-1') });
    expect(result.structuredContent).toMatchObject({
      count: 1,
      nextCursor: null,
      tickets: [
        expect.objectContaining({
          key: 'ORB-1',
          statusCategory: 'in_progress',
          assigneeNames: ['a@example.com'],
        }),
      ],
    });
    const row = (result.structuredContent as { tickets: Record<string, unknown>[] }).tickets[0];
    expect(row.id).toBeUndefined();
    expect(row.labels).toBeUndefined();
    expect(row.estimatedTimeMinutes).toBeUndefined();
  });

  it('renders the empty-result text block', async () => {
    mockFetch({ items: [], nextCursor: null });
    const result = await makeQueryHandler(client)({ oql: 'priority = blocker' });
    expect(result.content[0]).toEqual({ type: 'text', text: 'No tickets matched.' });
  });

  it('hints at the next cursor when more pages exist', async () => {
    mockFetch({
      items: [{ id: 't1', ticketKey: 'ORB-1', title: 'a', status: 'TODO', priority: 'normal', type: 'task' }],
      nextCursor: 'opaque-cursor-token',
    });
    const result = await makeQueryHandler(client)({ oql: '' });
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain('opaque-cursor-token');
    expect(result.structuredContent).toMatchObject({ nextCursor: 'opaque-cursor-token' });
  });

  it('forwards syntax="jql" verbatim so the API runs the JQL adapter', async () => {
    const spy = mockFetch({ items: [], nextCursor: null });
    await makeQueryHandler(client)({ oql: 'resolution = Done', syntax: 'jql' });
    expect(spy).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        body: JSON.stringify({ oql: 'resolution = Done', syntax: 'jql', cursor: undefined, limit: 25 }),
      }),
    );
  });
});

import { metricsToolName } from '../tail-labels.js';
import { parseRetryAfter } from '../orboto-client.js';
import { QUERY_RETRY } from './query.js';

function rateLimited(retryAfter: string | null, errorParams: Record<string, unknown> = {}) {
  return {
    ok: false, status: 429, statusText: 'Too Many Requests',
    headers: new Headers(retryAfter === null ? {} : { 'retry-after': retryAfter }),
    text: async () => JSON.stringify({ error: 'Rate limit exceeded', errorKey: 'errors.common.rate_limited', errorParams }),
  } as unknown as Response;
}

function ok(json: unknown) {
  return { ok: true, status: 200, statusText: 'OK', headers: new Headers(), json: async () => json } as unknown as Response;
}

describe('tools/query - 429 and Retry-After (ORB-2581)', () => {
  const client = new OrbotoClient({ baseUrl: 'https://orboto.example.com', apiKey: 'orb_test' });

  it('waits the Retry-After seconds and retries until the query answers', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(rateLimited('3'))
      .mockResolvedValueOnce(ok({ items: [], nextCursor: null }));
    const sleep = vi.fn(async () => {});
    const result = await makeQueryHandler(client, sleep)({ oql: 'project = ORB' });
    expect(sleep).toHaveBeenCalledWith(3000);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(result.isError).toBeUndefined();
    expect(result.content[0]).toEqual({ type: 'text', text: 'No tickets matched.' });
  });

  it('stops after the bounded retries and answers with the retry hint', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(rateLimited('5', { retryAfterSeconds: 5, limitPerMinute: 60 }));
    const sleep = vi.fn(async () => {});
    const result = await makeQueryHandler(client, sleep)({ oql: 'project = ORB' });
    expect(fetchSpy).toHaveBeenCalledTimes(QUERY_RETRY.maxRetries + 1);
    expect(sleep).toHaveBeenCalledTimes(QUERY_RETRY.maxRetries);
    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain('Retry after 5 seconds');
    expect(result.structuredContent).toEqual({ rateLimited: true, retryAfterSeconds: 5, limitPerMinute: 60, attempts: QUERY_RETRY.maxRetries + 1 });
  });

  it('never waits longer than the cap: a long Retry-After answers at once', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(rateLimited(String(QUERY_RETRY.maxWaitSeconds + 1)));
    const sleep = vi.fn(async () => {});
    const result = await makeQueryHandler(client, sleep)({ oql: 'project = ORB' });
    expect(sleep).not.toHaveBeenCalled();
    expect(result.structuredContent).toMatchObject({ rateLimited: true, retryAfterSeconds: QUERY_RETRY.maxWaitSeconds + 1, attempts: 1 });
  });

  it('reads the wait from errorParams when a proxy dropped the header', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(rateLimited(null, { retryAfterSeconds: 7 }))
      .mockResolvedValueOnce(ok({ items: [], nextCursor: null }));
    const sleep = vi.fn(async () => {});
    await makeQueryHandler(client, sleep)({ oql: 'project = ORB' });
    expect(sleep).toHaveBeenCalledWith(7000);
  });

  it('passes every other error through unchanged', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: false, status: 400, statusText: 'Bad Request', headers: new Headers(), text: async () => '{"errorKey":"errors.oql.parse"}',
    } as unknown as Response);
    await expect(makeQueryHandler(client, vi.fn(async () => {}))({ oql: '((' })).rejects.toMatchObject({ status: 400 });
  });

  it('parses delta-seconds and HTTP dates', () => {
    expect(parseRetryAfter('12')).toBe(12);
    expect(parseRetryAfter(null)).toBeNull();
    expect(parseRetryAfter('soon')).toBeNull();
    expect(parseRetryAfter(new Date(Date.UTC(2026, 9, 18, 12, 0, 30)).toUTCString(), Date.UTC(2026, 9, 18, 12, 0, 0))).toBe(30);
  });

  it('labels the query limit tail routes for metrics', () => {
    const id = '00000000-0000-4000-8000-000000000000';
    expect(metricsToolName('orboto_api_call', { method: 'GET', path: `/admin/agents/identities/${id}/query-rate-limit` })).toBe('orboto_agent_query_rate_limit');
    expect(metricsToolName('orboto_api_call', { method: 'PUT', path: `/admin/agents/identities/${id}/query-rate-limit` })).toBe('orboto_agent_query_rate_limit');
  });
});

import { agentTicketListRow } from './shared.js';

describe('agentTicketListRow (ORB-1699)', () => {
  const FULL = {
    id: 'u-u-i-d', projectId: 'p1', milestoneId: null, milestoneName: 'M', ticketKey: 'ORB-9',
    ticketNumber: 9, title: 'T', status: 'TODO', statusName: 'To Do', statusCategory: 'todo',
    type: 'task', priority: 'high', estimatedTimeMinutes: 120, loggedMinutes: 30,
    dueDate: '2026-09-01', isPrivate: false, createdAt: 'c', updatedAt: 'u',
    assignees: [{ id: 'a1', email: 'a@x', fullName: 'Ada' }],
    labels: [{ id: 'l1', name: 'bug' }],
  };

  it('lean row: decision fields only, defaults omitted', () => {
    const row = agentTicketListRow(FULL as never);
    expect(Object.keys(row).sort()).toEqual(['assigneeNames', 'dueDate', 'key', 'priority', 'statusCategory', 'title']);
    expect(row.assigneeNames).toEqual(['Ada']);
  });

  it('lean row omits default-valued fields entirely', () => {
    const row = agentTicketListRow({ ...FULL, priority: 'normal', type: 'task', dueDate: null, assignees: [] } as never);
    expect(Object.keys(row).sort()).toEqual(['key', 'statusCategory', 'title']);
  });

  it('verbose restores uuid, labels, minutes, timestamps', () => {
    const row = agentTicketListRow(FULL as never, true);
    expect(row.id).toBe('u-u-i-d');
    expect(row.labels).toEqual(['bug']);
    expect(row.estimatedTimeMinutes).toBe(120);
    expect(row.loggedMinutes).toBe(30);
    expect(row.createdAt).toBe('c');
  });

  it('waitingForGitIngestion appears only when it fires', () => {
    expect(agentTicketListRow(FULL as never).waitingForGitIngestion).toBeUndefined();
    expect(agentTicketListRow({ ...FULL, waitingForGitIngestion: true } as never).waitingForGitIngestion).toBe(true);
  });
});
