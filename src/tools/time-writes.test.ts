/**
 * ORB-244 Phase C Group 2 — time-tracking tool tests.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OrbotoClient } from '../orboto-client.js';
import {
  makeTimerStartHandler, makeTimerStopHandler, makeLogTimeHandler,
} from './time-writes.js';

beforeEach(() => { vi.restoreAllMocks(); });
afterEach(() => { vi.restoreAllMocks(); });

function stub(responses: Array<{ ok?: boolean; status?: number; json?: unknown }>) {
  const calls: Array<{ url: string; method: string; body?: unknown }> = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    const u = url.toString();
    const m = init?.method ?? 'GET';
    const b = init?.body ? JSON.parse(init.body as string) : undefined;
    calls.push({ url: u, method: m, body: b });
    const r = responses.shift();
    if (!r) throw new Error(`unexpected extra fetch ${m} ${u}`);
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
const TICKET = { id: 't1', projectId: 'p1', ticketKey: 'ACME-1', title: 'Bug' };

describe('orbit_timer_start', () => {
  it('starts with description + replace=false default', async () => {
    const calls = stub([
      { json: PROJ },
      { json: TICKET },
      { json: { id: 'tm1', ticketId: 't1', startedAt: 'now', accumulatedSeconds: 0, description: 'debug', pausedAt: null } },
    ]);
    await makeTimerStartHandler(client)({ ticketKey: 'ACME-1', description: 'debug' });
    expect(calls[2].method).toBe('POST');
    expect(calls[2].url).toContain('/time/timer/start');
    expect(calls[2].body).toEqual({ ticketId: 't1', description: 'debug' });
  });

  it('passes replace=true when supplied', async () => {
    const calls = stub([
      { json: PROJ },
      { json: TICKET },
      { json: { id: 'tm1', ticketId: 't1', startedAt: 'now', accumulatedSeconds: 0, description: null, pausedAt: null } },
    ]);
    await makeTimerStartHandler(client)({ ticketKey: 'ACME-1', replace: true });
    expect(calls[2].body).toEqual({ ticketId: 't1', replace: true });
  });

  it('rewrites a 409 into a clear message about replace=true', async () => {
    stub([
      { json: PROJ },
      { json: TICKET },
      { ok: false, status: 409, json: { error: 'Timer already running' } },
    ]);
    await expect(
      makeTimerStartHandler(client)({ ticketKey: 'ACME-1' })
    ).rejects.toThrow(/replace=true/);
  });
});

describe('orbit_timer_stop', () => {
  it('returns durationMinutes from the API response', async () => {
    const calls = stub([{ json: { durationMinutes: 47 } }]);
    const res = await makeTimerStopHandler(client)();
    expect(calls[0].method).toBe('POST');
    expect(calls[0].url).toContain('/time/timer/stop');
    expect(res.structuredContent).toEqual({ durationMinutes: 47 });
    expect((res.content[0] as { text: string }).text).toContain('47 min');
  });

  it('treats 404 as idempotent (no active timer)', async () => {
    stub([{ ok: false, status: 404, json: { error: 'No active timer' } }]);
    const res = await makeTimerStopHandler(client)();
    const sc = res.structuredContent as { alreadyStopped: boolean };
    expect(sc.alreadyStopped).toBe(true);
  });
});

describe('orbit_log_time', () => {
  it('POSTs durationMinutes + optional description', async () => {
    const calls = stub([
      { json: PROJ },
      { json: TICKET },
      { json: { id: 'e1', ticketId: 't1', userId: 'u1', durationMinutes: 60, description: 'pair-debug', loggedAt: 'now' } },
    ]);
    await makeLogTimeHandler(client)({
      ticketKey: 'ACME-1', durationMinutes: 60, description: 'pair-debug',
    });
    expect(calls[2].method).toBe('POST');
    expect(calls[2].url).toContain('/tickets/t1/time-entries');
    expect(calls[2].body).toEqual({ durationMinutes: 60, description: 'pair-debug' });
  });

  it('passes loggedAt for backdated entries', async () => {
    const calls = stub([
      { json: PROJ },
      { json: TICKET },
      { json: { id: 'e1', ticketId: 't1', userId: 'u1', durationMinutes: 30, description: null, loggedAt: '2026-04-20T10:00:00Z' } },
    ]);
    await makeLogTimeHandler(client)({
      ticketKey: 'ACME-1', durationMinutes: 30, loggedAt: '2026-04-20T10:00:00Z',
    });
    expect(calls[2].body).toEqual({ durationMinutes: 30, loggedAt: '2026-04-20T10:00:00Z' });
  });
});
