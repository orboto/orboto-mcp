/**
 * ORB-626 - ticket meeting-schedule tool tests.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OrbotoClient } from '../orboto-client.js';
import {
  makeListTicketSchedulesHandler,
  makeScheduleTicketSessionHandler,
  makeCancelTicketSessionHandler,
} from './ticket-schedules.js';

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
    const payload = 'json' in r ? r.json : {};
    return {
      ok: r.ok ?? true,
      status: r.status ?? 200,
      statusText: 'OK',
      json: async () => payload,
      // delete<T> reads text() then JSON.parses it - serialise the payload.
      text: async () => JSON.stringify(payload),
    } as unknown as Response;
  });
  return calls;
}

const client = new OrbotoClient({ baseUrl: 'https://orboto.example.com', apiKey: 'orb_x' });
const PROJ = { id: 'p1', key: 'ACME', name: 'Acme', description: null, status: 'active' };
const TICKET = { id: 't1', projectId: 'p1', ticketKey: 'ACME-1', title: 'Bug' };

function schedule(overrides: Record<string, unknown> = {}) {
  return {
    id: 's1', ticketId: 't1', createdBy: 'u1', title: 'Working session: ACME-1',
    startsAt: '2026-07-20T10:00:00Z', endsAt: '2026-07-20T11:00:00Z',
    location: null, notes: null, attendees: [{ userId: 'u2', email: 'a@x.io' }],
    externalAttendees: [{ email: 'ext@client.com' }], sequence: 0,
    cancelledAt: null, createdAt: 'now', updatedAt: 'now', ...overrides,
  };
}

describe('orboto_list_ticket_schedules', () => {
  it('lists active sessions by default', async () => {
    const calls = stub([{ json: PROJ }, { json: TICKET }, { json: [schedule()] }]);
    const res = await makeListTicketSchedulesHandler(client)({ ticketKey: 'ACME-1' });
    expect(calls[2].method).toBe('GET');
    expect(calls[2].url).toContain('/tickets/t1/schedules');
    expect(calls[2].url).not.toContain('includeCancelled');
    expect((res.structuredContent as { schedules: unknown[] }).schedules).toHaveLength(1);
  });

  it('passes includeCancelled=true when requested', async () => {
    const calls = stub([{ json: PROJ }, { json: TICKET }, { json: [] }]);
    await makeListTicketSchedulesHandler(client)({ ticketKey: 'ACME-1', includeCancelled: true });
    expect(calls[2].url).toContain('includeCancelled=true');
  });
});

describe('orboto_schedule_ticket_session', () => {
  it('POSTs the session with attendees + external emails', async () => {
    const calls = stub([{ json: PROJ }, { json: TICKET }, { json: schedule() }]);
    const res = await makeScheduleTicketSessionHandler(client)({
      ticketKey: 'ACME-1',
      startsAt: '2026-07-20T10:00:00Z',
      endsAt: '2026-07-20T11:00:00Z',
      attendeeUserIds: ['u2'],
      externalEmails: ['ext@client.com'],
    });
    expect(calls[2].method).toBe('POST');
    expect(calls[2].url).toContain('/tickets/t1/schedules');
    expect(calls[2].body).toEqual({
      startsAt: '2026-07-20T10:00:00Z',
      endsAt: '2026-07-20T11:00:00Z',
      attendeeUserIds: ['u2'],
      externalEmails: ['ext@client.com'],
    });
    expect((res.structuredContent as { scheduleId: string }).scheduleId).toBe('s1');
  });

  it('defaults attendee arrays to empty when omitted', async () => {
    const calls = stub([{ json: PROJ }, { json: TICKET }, { json: schedule({ attendees: [], externalAttendees: [] }) }]);
    await makeScheduleTicketSessionHandler(client)({
      ticketKey: 'ACME-1',
      startsAt: '2026-07-20T10:00:00Z',
      endsAt: '2026-07-20T11:00:00Z',
    });
    expect(calls[2].body).toEqual({
      startsAt: '2026-07-20T10:00:00Z',
      endsAt: '2026-07-20T11:00:00Z',
      attendeeUserIds: [],
      externalEmails: [],
    });
  });
});

describe('orboto_cancel_ticket_session', () => {
  it('DELETEs the session by id and reports the cancelled title', async () => {
    const calls = stub([{ json: PROJ }, { json: TICKET }, { json: schedule({ cancelledAt: 'now' }) }]);
    const res = await makeCancelTicketSessionHandler(client)({ ticketKey: 'ACME-1', scheduleId: 's1' });
    expect(calls[2].method).toBe('DELETE');
    expect(calls[2].url).toContain('/tickets/t1/schedules/s1');
    expect((res.structuredContent as { cancelled: boolean }).cancelled).toBe(true);
    expect((res.content[0] as { text: string }).text).toContain('Working session: ACME-1');
  });
});
