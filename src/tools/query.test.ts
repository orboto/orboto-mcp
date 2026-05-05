/**
 * ORB-273 Phase F — `orbit_query` MCP tool tests.
 *
 * Confirms the handler:
 *   - posts to /query with the right body shape
 *   - emits a human-readable text block + structured-content envelope
 *   - surfaces nextCursor + a "more pages" hint
 *   - propagates the syntax flag (jql vs oql) verbatim
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { OrbitClient } from '../orbit-client.js';
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
  const client = new OrbitClient({ baseUrl: 'https://orboto.example.com', apiKey: 'orb_test' });

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
          status: 'In Progress',
          assignees: ['a@example.com'],
          labels: ['frontend'],
        }),
      ],
    });
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
