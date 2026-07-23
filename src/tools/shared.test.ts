/**
 * ORB-244 Phase B — key-resolver helpers.
 *
 * The two-step ticket resolution (project key → project UUID →
 * ticket) is the most reused code path in the tool suite, so
 * exercising the edge cases here beats duplicating them in every
 * tool test.
 */
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { OrbotoClient } from '../orboto-client.js';
import { resolveProjectByKey, resolveTicketByKey, ticketLine } from './shared.js';

beforeEach(() => { vi.restoreAllMocks(); });
afterEach(() => { vi.restoreAllMocks(); });

function sequence(responses: Array<{ ok?: boolean; status?: number; json?: unknown; text?: string }>) {
  const calls: string[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
    calls.push(url.toString());
    const r = responses.shift();
    if (!r) throw new Error('unexpected extra fetch');
    return {
      ok: r.ok ?? true,
      status: r.status ?? 200,
      statusText: 'OK',
      json: async () => r.json ?? {},
      text: async () => r.text ?? '',
    } as unknown as Response;
  });
  return calls;
}

const client = new OrbotoClient({ baseUrl: 'https://orboto.example.com', apiKey: 'orb_x' });

describe('resolveProjectByKey', () => {
  it('returns the project on success', async () => {
    sequence([{ json: { id: 'p1', key: 'ACME', name: 'Acme', description: null, status: 'active' } }]);
    const p = await resolveProjectByKey(client, 'acme');
    expect(p.key).toBe('ACME');
  });

  it('rewrites a 404 into a helpful message', async () => {
    sequence([{ ok: false, status: 404, text: '{"error":"Project not found"}' }]);
    await expect(resolveProjectByKey(client, 'NOPE')).rejects.toThrow(/Project "NOPE" not found/);
  });

  it('URL-encodes the key', async () => {
    const calls = sequence([{ json: { id: 'p1', key: 'AB CD', name: 'x', description: null, status: 'active' } }]);
    await resolveProjectByKey(client, 'AB CD');
    expect(calls[0]).toBe('https://orboto.example.com/projects/by-key/AB%20CD');
  });
});

describe('resolveTicketByKey', () => {
  it('splits on the first dash, resolves project then ticket', async () => {
    const calls = sequence([
      { json: { id: 'p1', key: 'ACME', name: 'Acme', description: null, status: 'active' } },
      { json: { id: 't1', projectId: 'p1', ticketKey: 'ACME-42', title: 'Fix it' } },
    ]);
    const t = await resolveTicketByKey(client, 'ACME-42');
    expect(t.ticketKey).toBe('ACME-42');
    expect(calls[0]).toContain('/projects/by-key/ACME');
    expect(calls[1]).toContain('/projects/p1/tickets/by-key/42');
  });

  it('rejects malformed keys (no dash)', async () => {
    await expect(resolveTicketByKey(client, 'PLAIN')).rejects.toThrow(/expected format "PROJ-123"/);
  });

  it('rewrites a 404 into a ticket-scoped message', async () => {
    sequence([
      { json: { id: 'p1', key: 'ACME', name: 'Acme', description: null, status: 'active' } },
      { ok: false, status: 404, text: 'not found' },
    ]);
    await expect(resolveTicketByKey(client, 'ACME-999')).rejects.toThrow(/Ticket "ACME-999" not found in project "ACME"/);
  });
});

describe('ticketLine', () => {
  it('renders key, title, status, priority, assignees', () => {
    const line = ticketLine({
      id: 't1', projectId: 'p1', milestoneId: null,
      ticketKey: 'ACME-1', ticketNumber: 1,
      title: 'Login broken',
      status: 'IN_PROGRESS', statusName: 'In Progress',
      type: 'bug', priority: 'high',
      estimatedTimeMinutes: 0, dueDate: null, isPrivate: false,
      assignees: [{ id: 'u1', email: 'a@b.c', fullName: 'Ada Lovelace' }],
    });
    expect(line).toBe('[ACME-1] Login broken (In Progress) <high> → Ada Lovelace');
  });

  it('omits priority marker when normal, omits assignee clause when none', () => {
    const line = ticketLine({
      id: 't1', projectId: 'p1', milestoneId: null,
      ticketKey: 'ACME-2', ticketNumber: 2,
      title: 'Docs update',
      status: 'TODO', statusName: 'To Do',
      type: 'task', priority: 'normal',
      estimatedTimeMinutes: 0, dueDate: null, isPrivate: false,
    });
    expect(line).toBe('[ACME-2] Docs update (To Do)');
  });

  // ORB-1605 — flags the stalled-ingestion signal in the one-line summary.
  it('appends the waiting-on-ingestion marker when waitingForGitIngestion is true', () => {
    const line = ticketLine({
      id: 't1', projectId: 'p1', milestoneId: null,
      ticketKey: 'ACME-3', ticketNumber: 3,
      title: 'Docs change',
      status: 'IN_REVIEW', statusName: 'In Review',
      type: 'task', priority: 'normal',
      estimatedTimeMinutes: 0, dueDate: null, isPrivate: false,
      waitingForGitIngestion: true,
    });
    expect(line).toBe('[ACME-3] Docs change (In Review) [waiting on Git ingestion]');
  });

  it('omits the marker when waitingForGitIngestion is false or absent', () => {
    const line = ticketLine({
      id: 't1', projectId: 'p1', milestoneId: null,
      ticketKey: 'ACME-4', ticketNumber: 4,
      title: 'Docs change',
      status: 'IN_REVIEW', statusName: 'In Review',
      type: 'task', priority: 'normal',
      estimatedTimeMinutes: 0, dueDate: null, isPrivate: false,
      waitingForGitIngestion: false,
    });
    expect(line).toBe('[ACME-4] Docs change (In Review)');
  });
});
