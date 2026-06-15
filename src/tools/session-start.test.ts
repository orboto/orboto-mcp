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
});
