/**
 * ORB-273 Phase F — `orboto_query` MCP tool tests.
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
    // ORB-1699 - the default row is the shared lean projection: no uuid,
    // no labels, no minutes; assignee NAMES (fullName || email).
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

// ORB-1699 - the ONE row builder, asserted from one place: the lean shape
// omits uuid/timestamps/minutes; verbose restores them. list_tickets,
// my_tickets and query all consume agentTicketListRow, so this single
// test pins the row for all three.
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
    // priority 'high' and dueDate present -> included; type stays only
    // when it deviates from 'task'; status NAME is verbose-only.
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
