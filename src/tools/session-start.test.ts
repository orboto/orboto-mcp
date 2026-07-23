/**
 * ORB-1093 — session-start composes 4 reads into a re-orientation
 * digest. Assert it hits the right endpoints and folds the rules +
 * in-progress work + timer into the output.
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
    const structured = res.structuredContent as { gitHealth: Array<{ projectId: string; connections: unknown[] }> };
    expect(structured.gitHealth).toHaveLength(1);
    expect(structured.gitHealth[0].projectId).toBe('proj-1');
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
