/**
 * ORB-244 Phase C Group 2 - time-tracking tool tests.
 */
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OrbotoClient } from '../orboto-client.js';
import {
  makeTimerStartHandler, makeTimerStopHandler, makeLogTimeHandler,
  makeListTimeEntriesHandler, makeEditTimeEntryHandler, makeDeleteTimeEntryHandler, TIME_ENTRY_SOURCES,
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

describe('orboto_timer_start', () => {
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

describe('orboto_timer_stop', () => {
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

  it('ORB-3102 - ticketKey stops the session timer on that ticket', async () => {
    const calls = stub([{ json: PROJ }, { json: TICKET }, { json: { durationMinutes: 12, stopped: true, laneFallback: false } }]);
    const res = await makeTimerStopHandler(client)({ ticketKey: 'ACME-1' });
    expect(calls[2]).toMatchObject({ method: 'POST', body: { ticketId: 't1' } });
    expect(calls[2].url).toContain('/time/timer/stop');
    expect(res.structuredContent).toEqual({ durationMinutes: 12 });
  });

  it('ORB-2632 - says nothing was booked when the API refused the booking', async () => {
    stub([{ json: { durationMinutes: 0, stopped: true, laneFallback: false, bookingRefused: true } }]);
    const res = await makeTimerStopHandler(client)();
    expect(res.structuredContent).toEqual({ durationMinutes: 0, bookingRefused: true });
    expect((res.content[0] as { text: string }).text).toContain('nothing booked');
  });
});

describe('orboto_log_time', () => {
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

describe('orboto_log_time with dates (ORB-2056)', () => {
  it('books through POST /time-entries/bulk with a template and reports the total', async () => {
    const calls = stub([
      { json: PROJ },
      { json: TICKET },
      { json: { entries: [{ id: 'e1', ticketId: 't1', userId: 'u1', durationMinutes: 120, description: 'sprint', loggedAt: '2026-06-01T07:00:00.000Z' }, { id: 'e2', ticketId: 't1', userId: 'u1', durationMinutes: 120, description: 'sprint', loggedAt: '2026-06-02T07:00:00.000Z' }], warnings: [{ kind: 'non_working_day', date: '2026-06-06', message: 'x' }], lockedDates: [], dryRun: false, totalMinutes: 240 } },
    ]);
    const out = await makeLogTimeHandler(client)({
      ticketKey: 'ACME-1', durationMinutes: 120, description: 'sprint', dates: ['2026-06-01', '2026-06-02'], time: '09:00', loggedAt: '2026-01-01T00:00:00Z',
    });
    expect(calls[2].method).toBe('POST');
    expect(calls[2].url).toContain('/time-entries/bulk');
    expect(calls[2].body).toEqual({ template: { ticketId: 't1', durationMinutes: 120, description: 'sprint', time: '09:00' }, dates: ['2026-06-01', '2026-06-02'] });
    expect((out.structuredContent as { totalMinutes: number }).totalMinutes).toBe(240);
    expect((out.content[0] as { text: string }).text).toContain('2 day(s)');
    expect((out.content[0] as { text: string }).text).toContain('capacity warning');
  });
});

describe('orboto_list_time_entries / edit / delete (ORB-1292)', () => {
  it('list GETs the ticket time entries and returns them structured', async () => {
    const calls = stub([
      { json: PROJ },
      { json: TICKET },
      { json: { items: [{ id: 'e1', ticketId: 't1', userId: 'u1', durationMinutes: 476, loggedAt: 'now' }], nextCursor: null } },
      { json: { ticketId: 't1', minutes: { total: 476, lease: 0, timer: 0, manual: 476, unrecorded: 0 }, usage: null, leases: [] } },
    ]);
    const res = await makeListTimeEntriesHandler(client)({ ticketKey: 'ACME-1' });
    expect(calls[2].method).toBe('GET');
    expect(calls[2].url).toContain('/tickets/t1/time-entries');
    expect(calls[3].url).toContain('/tickets/t1/agent-time');
    expect((res.structuredContent as { entries: unknown[] }).entries).toHaveLength(1);
    expect((res.content[0] as { text: string }).text).toContain('Agent usage: no usage reported');
  });

  it('ORB-3102 - names each entry\'s source, the minutes per source, the reported usage and the running leases', async () => {
    stub([
      { json: PROJ },
      { json: TICKET },
      { json: { items: [{ id: 'e1', ticketId: 't1', userId: 'u1', durationMinutes: 40, loggedAt: 'now', source: 'lease', agentLabel: 'claude-code#ab12' }], nextCursor: null } },
      { json: {
        ticketId: 't1', minutes: { total: 40, lease: 40, timer: 0, manual: 0, unrecorded: 0 },
        usage: { inputTokens: 10, outputTokens: 2, cacheReadTokens: 100, cacheWriteTokens: null, weightedTokens: 35, costUsd: 1.25, reports: 3 },
        leases: [{ id: 'l1', userId: 'u1', userEmail: null, userFullName: null, agentSessionId: 's1', agentLabel: 'claude-code#ab12', startedAt: 'now', endedAt: null, stoppedBy: null, bookedMinutes: 0, accruedMinutes: 7, timeEntryId: null, continuesLeaseId: null, usage: null }],
      } },
    ]);
    const res = await makeListTimeEntriesHandler(client)({ ticketKey: 'ACME-1' });
    const text = (res.content[0] as { text: string }).text;
    expect(text).toContain('40 min (lease)');
    expect(text).toContain('40 min booked: lease 40, timer 0, manual 0');
    expect(text).toContain('Agent usage: 35 weighted tokens (in 10, out 2, cache read 100, cache write not reported), $1.25');
    expect(text).toContain('Running agent leases: claude-code#ab12 7 min so far');
    const structured = res.structuredContent as { agentTime: { usage: { costUsd: number }; minutes: { lease: number }; runningLeases: unknown[]; leases?: unknown } };
    expect(structured.agentTime.usage.costUsd).toBe(1.25);
    expect(structured.agentTime.minutes.lease).toBe(40);
    expect(structured.agentTime.runningLeases).toHaveLength(1);
    expect(structured.agentTime.leases).toBeUndefined();
  });

  it('ORB-3102 - the structured answer carries no more than the running leases, however many leases the ticket has', async () => {
    const lease = (n: number) => ({ id: `l${n}`, userId: 'u1', userEmail: null, userFullName: null, agentSessionId: 's1', agentLabel: `a#${n}`, startedAt: 'now', endedAt: n === 0 ? null : 'later', stoppedBy: n === 0 ? null : 'finish', bookedMinutes: 5, accruedMinutes: 5, timeEntryId: null, continuesLeaseId: null, usage: null });
    stub([
      { json: PROJ },
      { json: TICKET },
      { json: { items: [], nextCursor: null } },
      { json: { ticketId: 't1', minutes: { total: 1000, lease: 1000, timer: 0, manual: 0, unrecorded: 0 }, usage: null, leases: Array.from({ length: 200 }, (_, n) => lease(n)) } },
    ]);
    const res = await makeListTimeEntriesHandler(client)({ ticketKey: 'ACME-1' });
    const structured = res.structuredContent as { agentTime: { runningLeases: unknown[] } };
    expect(structured.agentTime.runningLeases).toHaveLength(1);
    expect(JSON.stringify(res.structuredContent).length).toBeLessThan(2000);
  });

  it('ORB-3102 - mirrors the time entry sources of shared-schema', () => {
    const shared = readFileSync(new URL('../../../../packages/shared-schema/src/activity.ts', import.meta.url), 'utf8');
    expect(shared).toContain(`TimeEntrySourceEnum = z.enum([${TIME_ENTRY_SOURCES.map((v) => `'${v}'`).join(', ')}])`);
    expect(shared).toContain('declaredNone: DoneWithoutTimeSchema.nullable()');
    expect(TIME_ENTRY_SOURCES).not.toContain('declared_none');
  });

  it('ORB-3102 - carries exactly the fields of the shared agent-time schemas, none added and none missing', () => {
    const shared = readFileSync(new URL('../../../../packages/shared-schema/src/activity.ts', import.meta.url), 'utf8');
    const local = readFileSync(new URL('./time-writes.ts', import.meta.url), 'utf8');
    const block = (src: string, start: string) => {
      const from = src.indexOf(start);
      expect(from, start).toBeGreaterThan(-1);
      return src.slice(from, src.indexOf('\n}', from));
    };
    const keys = (text: string, indent: number) => [...text.matchAll(new RegExp(`^ {${indent}}(\\w+)\\??: `, 'gm'))].map((m) => m[1]!).sort();
    const inline = (text: string) => [...text.matchAll(/(\w+)\??: /g)].map((m) => m[1]!).sort();

    expect(keys(block(local, 'export interface AgentUsageTotals'), 2)).toEqual(keys(block(shared, 'export const AgentUsageTotalsSchema'), 2));
    expect(keys(block(local, 'export interface DoneWithoutTime '), 2)).toEqual(keys(block(shared, 'export const DoneWithoutTimeSchema'), 2));
    const agentTime = block(local, 'export interface TicketAgentTime');
    expect(keys(agentTime, 2)).toEqual(keys(block(shared, 'export const TicketAgentTimeSchema'), 2));
    expect(inline(/minutes: \{([^}]*)\}/.exec(agentTime)![1]!)).toEqual(keys(/minutes: z\.object\(\{([\s\S]*?)\n {2}\}\)/.exec(block(shared, 'export const TicketAgentTimeSchema'))![1]!, 4));
    expect(inline(/leases: Array<\{([\s\S]*?)\}>/.exec(agentTime)![1]!)).toEqual(keys(block(shared, 'export const AgentTicketLeaseSchema'), 2));
  });

  it('ORB-3102 - lists the entries when the agent-time call fails, naming that and leaving the agent time out', async () => {
    stub([
      { json: PROJ },
      { json: TICKET },
      { json: { items: [{ id: 'e1', ticketId: 't1', userId: 'u1', durationMinutes: 25, loggedAt: 'now', source: 'manual' }], nextCursor: null } },
      { ok: false, status: 500, json: { errorKey: 'errors.common.internal' } },
    ]);
    const res = await makeListTimeEntriesHandler(client)({ ticketKey: 'ACME-1' });
    const text = (res.content[0] as { text: string }).text;
    expect(text).toContain('25 min (manual)');
    expect(text).toContain('Agent time could not be read for this ticket.');
    expect(text).not.toContain('Agent usage');
    const structured = res.structuredContent as { entries: unknown[]; agentTime?: unknown };
    expect(structured.entries).toHaveLength(1);
    expect('agentTime' in structured).toBe(false);
  });

  it('ORB-3101 - names the declaration of an agent that moved the ticket into done without time, from the activity, and says nothing when time is booked', async () => {
    const declared = { reason: 'research only', at: '2026-11-17T10:00:00.000Z', accountId: 'u1', accountEmail: 'bot@x.test', accountName: null, agentSession: 'claude-code#ab12', status: 'Done', automatic: false, source: null };
    stub([
      { json: PROJ },
      { json: TICKET },
      { json: { items: [], nextCursor: null } },
      { json: { ticketId: 't1', minutes: { total: 0, lease: 0, timer: 0, manual: 0, unrecorded: 0 }, declaredNone: declared, usage: null, leases: [] } },
    ]);
    const res = await makeListTimeEntriesHandler(client)({ ticketKey: 'ACME-1' });
    expect((res.content[0] as { text: string }).text).toContain('No time booked: claude-code#ab12 moved it to Done on 2026-11-17T10:00:00.000Z without time - "research only"');
    expect((res.structuredContent as { agentTime: { declaredNone: unknown } }).agentTime.declaredNone).toEqual(declared);

    stub([
      { json: PROJ },
      { json: TICKET },
      { json: { items: [], nextCursor: null } },
      { json: { ticketId: 't1', minutes: { total: 30, lease: 30, timer: 0, manual: 0, unrecorded: 0 }, declaredNone: null, usage: null, leases: [] } },
    ]);
    const booked = await makeListTimeEntriesHandler(client)({ ticketKey: 'ACME-1' });
    expect((booked.content[0] as { text: string }).text).not.toContain('No time booked');
  });

  it('edit PATCHes the entry by id with the new duration', async () => {
    const calls = stub([
      { json: PROJ },
      { json: TICKET },
      { json: { id: 'e1', ticketId: 't1', userId: 'u1', durationMinutes: 45, loggedAt: 'now' } },
    ]);
    await makeEditTimeEntryHandler(client)({ ticketKey: 'ACME-1', entryId: 'e1', durationMinutes: 45 });
    expect(calls[2].method).toBe('PATCH');
    expect(calls[2].url).toContain('/tickets/t1/time-entries/e1');
    expect(calls[2].body).toEqual({ durationMinutes: 45 });
  });

  it('delete DELETEs the entry by id', async () => {
    const calls = stub([
      { json: PROJ },
      { json: TICKET },
      { json: {} },
    ]);
    const res = await makeDeleteTimeEntryHandler(client)({ ticketKey: 'ACME-1', entryId: 'e1' });
    expect(calls[2].method).toBe('DELETE');
    expect(calls[2].url).toContain('/tickets/t1/time-entries/e1');
    expect((res.structuredContent as { deleted: boolean }).deleted).toBe(true);
  });
});
