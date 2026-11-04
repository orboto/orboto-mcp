/**
 * ORB-2830 - the MCP ticket tools return who holds the ticket's live work session (`workingNow`), and the row the tools read mirrors
 * `TicketWorkingNowSchema` in @orboto/shared-schema (the MCP package does not depend on it, so the drift test loads the schema at run time).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fileURLToPath } from 'node:url';
import { OrbotoClient } from '../orboto-client.js';
import { makeListTicketsHandler } from './list-tickets.js';
import { makeGetTicketHandler } from './get-ticket.js';
import { makeMyTicketsHandler } from './my-tickets.js';
import { workingNowSummary, type TicketWorkingNowRow } from './shared.js';

interface SharedShape { shape: Record<string, unknown>; safeParse(value: unknown): { success: boolean } }

async function sharedSchema<T extends string>(file: string, name: T): Promise<SharedShape> {
  const mod: Record<string, SharedShape> = await import(/* @vite-ignore */ fileURLToPath(new URL(`../../../../packages/shared-schema/src/${file}.ts`, import.meta.url)));
  return mod[name];
}

beforeEach(() => { vi.restoreAllMocks(); });
afterEach(() => { vi.restoreAllMocks(); });

function stub(responses: Array<{ json: unknown }>) {
  const calls: string[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
    calls.push(url.toString());
    const r = responses.shift();
    if (!r) throw new Error(`unexpected extra fetch to ${url}`);
    return { ok: true, status: 200, statusText: 'OK', json: async () => r.json, text: async () => '' } as unknown as Response;
  });
  return calls;
}

const client = new OrbotoClient({ baseUrl: 'https://orboto.example.com', apiKey: 'orb_x' });
const PROJ = { id: 'p1', key: 'ACME', name: 'Acme', description: '', status: 'active' };
const HOLDER: TicketWorkingNowRow = {
  workSessionId: '11111111-1111-4111-8111-111111111111',
  userId: '22222222-2222-4222-8222-222222222222',
  fullName: 'Review Agent',
  avatarUrl: null,
  isBot: true,
  role: 'review',
  laneName: 'review-acme',
  startedAt: '2026-11-04T17:24:27.808856+00:00',
  leaseUntil: '2026-11-04T17:39:27.808856+00:00',
};
const ticket = (workingNow: TicketWorkingNowRow | null) => ({
  id: 't1', projectId: 'p1', ticketKey: 'ACME-1', title: 'Claimed by a lane', status: 'IN_REVIEW', statusName: 'In Review', statusCategory: 'in_review',
  type: 'task', priority: 'normal', estimatedTimeMinutes: 0, dueDate: null, milestoneId: null, isPrivate: false, assignees: [], parentTicketId: null, workingNow,
});
const SUMMARY = { name: 'Review Agent', bot: true, role: 'review', lane: 'review-acme', since: '2026-11-04T17:24:27.808856+00:00' };

const SUMMARY_KEY: Record<keyof TicketWorkingNowRow, string | null> = {
  workSessionId: null,
  userId: null,
  fullName: 'name',
  avatarUrl: null,
  isBot: 'bot',
  role: 'role',
  laneName: 'lane',
  startedAt: 'since',
  leaseUntil: null,
};

describe('ORB-2830 - workingNow drift', () => {
  it('the MCP row, the key classification and the agent summary cover exactly the fields of TicketWorkingNowSchema', async () => {
    const schema = await sharedSchema('work-sessions', 'TicketWorkingNowSchema');
    const sharedKeys = Object.keys(schema.shape).sort();
    expect(Object.keys(HOLDER).sort()).toEqual(sharedKeys);
    expect(Object.keys(SUMMARY_KEY).sort()).toEqual(sharedKeys);
    expect(schema.safeParse(HOLDER).success).toBe(true);

    const summarised = Object.keys(workingNowSummary(HOLDER)!).sort();
    expect(summarised).toEqual(Object.values(SUMMARY_KEY).filter((key): key is string => key !== null).sort());
  });

  it('TicketSchema carries the holder as workingNow', async () => {
    const ticketSchema = await sharedSchema('tickets', 'TicketSchema');
    expect(Object.keys(ticketSchema.shape)).toContain('workingNow');
  });
});

describe('ORB-2830 - orboto_list_tickets and orboto_my_tickets', () => {
  it('a compact row names the holder, a ticket without a live session has no workingNow key', async () => {
    stub([{ json: PROJ }, { json: { items: [ticket(HOLDER), { ...ticket(null), id: 't2', ticketKey: 'ACME-2' }], nextCursor: null } }]);
    const res = await makeListTicketsHandler(client)({ projectKey: 'ACME' });
    const rows = (res.structuredContent as { tickets: Array<Record<string, unknown>> }).tickets;
    expect(rows[0].workingNow).toEqual(SUMMARY);
    expect(rows[1]).not.toHaveProperty('workingNow');
    const text = (res.content[0] as { text: string }).text;
    expect(text).toContain('[ACME-1] Claimed by a lane (In Review) [working now: Review Agent (agent) - review, lane review-acme, since 2026-11-04T17:24:27.808856+00:00]');
    expect(text).not.toMatch(/ACME-2.*working now/);
  });

  it('a verbose row carries workingNow, null without a live session', async () => {
    stub([{ json: PROJ }, { json: { items: [ticket(HOLDER), { ...ticket(null), id: 't2' }], nextCursor: null } }]);
    const res = await makeListTicketsHandler(client)({ projectKey: 'ACME', verbose: true });
    const rows = (res.structuredContent as { tickets: Array<Record<string, unknown>> }).tickets;
    expect(rows[0].workingNow).toEqual(SUMMARY);
    expect(rows[1].workingNow).toBeNull();
  });

  it('my_tickets rows use the same builder', async () => {
    stub([{ json: { items: [ticket({ ...HOLDER, laneName: null, isBot: false, fullName: 'Ada' })], nextCursor: null } }]);
    const res = await makeMyTicketsHandler(client)({});
    const rows = (res.structuredContent as { tickets: Array<Record<string, unknown>> }).tickets;
    expect(rows[0].workingNow).toEqual({ name: 'Ada', bot: false, role: 'review', since: HOLDER.startedAt });
  });
});

describe('ORB-2830 - orboto_get_ticket', () => {
  it('the card names the holder in the header and the structured content', async () => {
    stub([{ json: PROJ }, { json: ticket(HOLDER) }, { json: ticket(HOLDER) }, { json: { items: [], nextCursor: null } }, { json: [] }]);
    const res = await makeGetTicketHandler(client)({ ticketKey: 'ACME-1' });
    expect((res.structuredContent as Record<string, unknown>).workingNow).toEqual(SUMMARY);
    expect((res.content[0] as { text: string }).text).toContain('Working now: Review Agent (agent) - review, lane review-acme, since 2026-11-04T17:24:27.808856+00:00');
  });

  it('returns workingNow null and no header line without a live session', async () => {
    stub([{ json: PROJ }, { json: ticket(null) }, { json: ticket(null) }, { json: { items: [], nextCursor: null } }, { json: [] }]);
    const res = await makeGetTicketHandler(client)({ ticketKey: 'ACME-1' });
    expect((res.structuredContent as Record<string, unknown>).workingNow).toBeNull();
    expect((res.content[0] as { text: string }).text).not.toContain('Working now');
  });
});
