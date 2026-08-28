/**
 * ORB-1694 - bulk create + bulk dependency writes.
 *
 * Pins the family contract: per-item error isolation (one bad draft
 * never drops the rest), compact one-line duplicate flags, reference
 * resolution cached per distinct value, 409-on-existing-edge counted
 * as success - and the acceptance criterion that a 20-item bulk create
 * answers in ONE response under ~2k characters.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OrbotoClient } from '../orboto-client.js';
import {
  makeBulkCreateTicketsHandler,
  makeBulkAddTicketDependenciesHandler,
} from './bulk-create.js';

afterEach(() => { vi.restoreAllMocks(); });

const client = new OrbotoClient({ baseUrl: 'https://orboto.example.com', apiKey: 'orb_test' });

interface Call { method: string; url: string; body: unknown }

/** Route-aware fetch stub: project + milestone resolution, then per-draft
 *  create responses driven by the draft title. */
function stubApi(opts: { failTitles?: string[]; dupTitles?: string[] } = {}): Call[] {
  const calls: Call[] = [];
  let seq = 0;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    const u = String(url);
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    calls.push({ method: init?.method ?? 'GET', url: u, body });
    const json = (payload: unknown, status = 200) => ({
      ok: status < 400, status, statusText: 'X',
      json: async () => payload, text: async () => JSON.stringify(payload),
    } as unknown as Response);
    if (u.includes('/projects/by-key/')) {
      return json({ id: 'proj-1', key: 'ACME', name: 'Acme' });
    }
    if (u.includes('/milestones')) {
      return json([{ id: 'ms-1', name: 'Sprint 1', milestoneKey: 'ACME-M1' }]);
    }
    if (u.includes('/tickets') && init?.method === 'POST') {
      const title = (body as { title: string }).title;
      if (opts.failTitles?.includes(title)) {
        return json({ error: 'label not found' }, 400);
      }
      seq++;
      return json({
        id: `t-${seq}`, ticketKey: `ACME-${seq}`, title,
        status: 'TODO', statusName: 'Todo', type: 'task', priority: 'normal',
        ...(opts.dupTitles?.includes(title)
          ? { similarWarnings: [{ id: 'x', ticketKey: 'ACME-99', title: 'existing', similarity: 0.87, matchMode: 'embedding' }] }
          : {}),
      }, 201);
    }
    throw new Error(`unexpected fetch ${u}`);
  });
  return calls;
}

describe('orboto_bulk_create_tickets', () => {
  it('20 drafts -> one compact response under 2k chars, milestone resolved once', async () => {
    const calls = stubApi();
    const handler = makeBulkCreateTicketsHandler(client);
    const result = await handler({
      projectKey: 'ACME',
      milestone: 'Sprint 1',
      tickets: Array.from({ length: 20 }, (_, i) => ({ title: `Task number ${i + 1}` })),
    });
    const sc = result.structuredContent as { created: string[]; failed: unknown[] };
    expect(sc.created).toHaveLength(20);
    expect(sc.failed).toHaveLength(0);
    const text = (result.content[0] as { text: string }).text;
    expect(text.length).toBeLessThan(2000);
    expect(JSON.stringify(result.structuredContent).length).toBeLessThan(2000);
    // Milestone resolved once, not once per draft.
    expect(calls.filter((c) => c.url.includes('/milestones')).length).toBe(1);
    // Every create carried the resolved milestone id.
    const creates = calls.filter((c) => c.method === 'POST' && c.url.includes('/tickets'));
    expect(creates).toHaveLength(20);
    expect(creates.every((c) => (c.body as { milestoneId?: string }).milestoneId === 'ms-1')).toBe(true);
  });

  it('per-draft isolation: a failed draft is reported while the rest are created; duplicates flag compactly', async () => {
    stubApi({ failTitles: ['broken draft'], dupTitles: ['maybe dup'] });
    const handler = makeBulkCreateTicketsHandler(client);
    const result = await handler({
      projectKey: 'ACME',
      tickets: [{ title: 'good one' }, { title: 'broken draft' }, { title: 'maybe dup' }],
    });
    const sc = result.structuredContent as {
      created: string[];
      failed: Array<{ index: number; title: string }>;
      duplicateFlags: Array<{ key: string; matches: Array<{ ticketKey: string; similarity: number }> }>;
    };
    expect(sc.created).toHaveLength(2);
    expect(sc.failed).toEqual([expect.objectContaining({ index: 1, title: 'broken draft' })]);
    expect(sc.duplicateFlags).toHaveLength(1);
    expect(sc.duplicateFlags[0].matches[0]).toMatchObject({ ticketKey: 'ACME-99', similarity: 0.87 });
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain('may duplicate ACME-99');
    expect(text).toContain('draft 1 "broken draft"');
  });
});

describe('orboto_bulk_add_ticket_dependencies', () => {
  it('resolves each key once, treats an existing edge (409) as ok, isolates per-pair failures', async () => {
    const calls: Call[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      const u = String(url);
      calls.push({ method: init?.method ?? 'GET', url: u, body: init?.body ? JSON.parse(init.body as string) : undefined });
      const json = (payload: unknown, status = 200) => ({
        ok: status < 400, status, statusText: 'X',
        json: async () => payload, text: async () => JSON.stringify(payload),
      } as unknown as Response);
      if (u.includes('/projects/by-key/')) {
        return json({ id: 'proj-1', key: 'ACME', name: 'Acme' });
      }
      if (u.includes('/tickets/by-key/')) {
        const num = decodeURIComponent(u.split('/tickets/by-key/')[1]);
        if (num === '404') return json({ error: 'not found' }, 404);
        return json({ id: `id-ACME-${num}`, ticketKey: `ACME-${num}`, projectId: 'proj-1', title: `ACME-${num}`, status: 'TODO', type: 'task', priority: 'normal' });
      }
      if (u.includes('/dependencies') && init?.method === 'POST') {
        const dependsOnId = (JSON.parse(init.body as string) as { dependsOnId: string }).dependsOnId;
        if (dependsOnId === 'id-ACME-1') return json({ error: 'exists' }, 409);
        return json({ ok: true }, 201);
      }
      throw new Error(`unexpected fetch ${u}`);
    });
    const handler = makeBulkAddTicketDependenciesHandler(client);
    const result = await handler({
      pairs: [
        { ticketKey: 'ACME-2', dependsOnKey: 'ACME-1' }, // 409 -> ok
        { ticketKey: 'ACME-3', dependsOnKey: 'ACME-2' }, // fresh edge
        { ticketKey: 'ACME-404', dependsOnKey: 'ACME-1' }, // unresolvable
      ],
    });
    const sc = result.structuredContent as { successful: string[]; failed: Array<{ pair: string }> };
    expect(sc.successful).toEqual(['ACME-2->ACME-1', 'ACME-3->ACME-2']);
    expect(sc.failed).toHaveLength(1);
    expect(sc.failed[0].pair).toBe('ACME-404->ACME-1');
    // Distinct keys resolved once each (ACME-1, ACME-2, ACME-3, ACME-404).
    expect(calls.filter((c) => c.url.includes('/tickets/by-key/')).length).toBe(4);
    // 409 on the first edge write still counted as successful (idempotent).
    expect(calls.filter((c) => c.method === 'POST' && c.url.includes('/dependencies')).length).toBe(2);
  });
});
