/**
 * ORB-799 - `orboto_list_ticket_statuses` + `orboto_list_labels` tests.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OrbotoApiError, OrbotoClient } from '../orboto-client.js';
import { makeListTicketStatusesHandler, makeListLabelsHandler, makeCreateLabelHandler } from './project-listings.js';

beforeEach(() => { vi.restoreAllMocks(); });
afterEach(() => { vi.restoreAllMocks(); });

function stub(responses: Array<{ ok?: boolean; status?: number; json?: unknown }>) {
  const calls: Array<{ url: string; method: string }> = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    calls.push({ url: url.toString(), method: init?.method ?? 'GET' });
    const r = responses.shift();
    if (!r) throw new Error(`unexpected extra fetch`);
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
const PROJ = { id: 'p1', key: 'ACME', name: 'Acme', description: null, status: 'active' };

describe('orboto_list_ticket_statuses', () => {
  it('renders status rows + structured content', async () => {
    stub([
      { json: PROJ },
      { json: [
        { id: 's1', name: 'To Do', category: 'todo', color: '#aaa', sortOrder: 0, isTerminal: false },
        { id: 's2', name: 'Done', category: 'done', color: '#0a0', sortOrder: 10, isTerminal: true },
      ] },
    ]);
    const res = await makeListTicketStatusesHandler(client)({ projectKey: 'ACME' });
    expect((res.content[0] as { text: string }).text).toContain('To Do');
    expect((res.content[0] as { text: string }).text).toContain('(terminal)');
    expect(res.structuredContent).toMatchObject({
      projectKey: 'ACME',
      statuses: [
        { name: 'To Do', category: 'todo', isTerminal: false },
        { name: 'Done', category: 'done', isTerminal: true },
      ],
    });
  });

  it('empty project returns helpful text', async () => {
    stub([{ json: PROJ }, { json: [] }]);
    const res = await makeListTicketStatusesHandler(client)({ projectKey: 'ACME' });
    expect((res.content[0] as { text: string }).text).toContain('No statuses');
  });

  it('surfaces 404 on missing project key', async () => {
    stub([{ ok: false, status: 404, json: { error: 'not found' } }]);
    await expect(
      makeListTicketStatusesHandler(client)({ projectKey: 'NOPE' }),
    ).rejects.toThrow(/Project "NOPE" not found/);
  });
});

describe('orboto_list_labels', () => {
  it('renders label rows + structured content', async () => {
    stub([
      { json: PROJ },
      { json: [
        { id: 'l1', name: 'bug', color: '#f00' },
        { id: 'l2', name: 'priority', color: '#ff0' },
      ] },
    ]);
    const res = await makeListLabelsHandler(client)({ projectKey: 'ACME' });
    expect((res.content[0] as { text: string }).text).toContain('bug');
    expect(res.structuredContent).toMatchObject({
      projectKey: 'ACME',
      labels: [
        { name: 'bug', color: '#f00' },
        { name: 'priority', color: '#ff0' },
      ],
    });
  });

  it('surfaces an OrbotoApiError on 403', async () => {
    stub([
      { json: PROJ },
      { ok: false, status: 403, json: { error: 'forbidden' } },
    ]);
    await expect(
      makeListLabelsHandler(client)({ projectKey: 'ACME' }),
    ).rejects.toBeInstanceOf(OrbotoApiError);
  });
});

describe('orboto_create_label (ORB-1041)', () => {
  it('creates a new label via POST when the name is free', async () => {
    const calls = stub([
      { json: PROJ },
      { json: [{ id: 'l1', name: 'bug', color: '#f00' }] },        // existing labels
      { json: { id: 'l2', name: 'security', color: '#6366f1' } },  // POST result
    ]);
    const res = await makeCreateLabelHandler(client)({ projectKey: 'ACME', name: 'security' });
    const post = calls.find((c) => c.method === 'POST')!;
    expect(post.url).toContain('/projects/p1/labels');
    expect(res.structuredContent).toMatchObject({ projectKey: 'ACME', label: { name: 'security' } });
  });

  it('is idempotent: returns the existing label without POSTing', async () => {
    const calls = stub([
      { json: PROJ },
      { json: [{ id: 'l1', name: 'Bug', color: '#f00' }] },
    ]);
    const res = await makeCreateLabelHandler(client)({ projectKey: 'ACME', name: 'bug' });
    expect(calls.some((c) => c.method === 'POST')).toBe(false);
    expect(res.structuredContent).toMatchObject({ alreadyExists: true, label: { name: 'Bug' } });
  });
});
