import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OrbotoClient } from '../orboto-client.js';
import { makeDraftCustomerReplyHandler } from './customer-draft.js';

beforeEach(() => { vi.restoreAllMocks(); });
afterEach(() => { vi.restoreAllMocks(); });

function stubJSON(responses: Array<{ ok?: boolean; status?: number; json?: unknown }>) {
  const calls: Array<{ url: string; method: string; body?: unknown }> = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    calls.push({ url: url.toString(), method: init?.method ?? 'GET', body: typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body });
    const r = responses.shift();
    if (!r) throw new Error('unexpected extra fetch');
    return { ok: r.ok ?? true, status: r.status ?? 200, statusText: 'OK', json: async () => ('json' in r ? r.json : {}), text: async () => '' } as unknown as Response;
  });
  return calls;
}

const client = new OrbotoClient({ baseUrl: 'https://orboto.example.com', apiKey: 'orb_x' });

describe('orboto_draft_customer_reply (ORB-2000)', () => {
  it('resolves the ticket key, POSTs the ask and renders draft + facts + exclusions', async () => {
    const calls = stubJSON([
      { json: { id: 'p1', key: 'ORB', name: 'orboto' } },
      { json: { id: 't1', ticketKey: 'ORB-42', title: 'Blank page after payment' } },
      { json: {
        draft: 'Thanks for the report - the blank page after payment is confirmed. We will follow up on the timeline.',
        factsUsed: [{ source: 'ticket.title', text: 'Blank page after payment' }, { source: 'user.ask', text: 'confirm it' }],
        excluded: { internalComments: 2, internalDescription: true },
      } },
    ]);
    const res = await makeDraftCustomerReplyHandler(client)({ ticketKey: 'ORB-42', ask: 'confirm it' });
    expect(calls[2]).toMatchObject({ method: 'POST', url: 'https://orboto.example.com/ai/draft-customer-reply', body: { ticketId: 't1', ask: 'confirm it' } });
    const text = (res.content[0] as { text: string }).text;
    expect(text).toContain('not posted');
    expect(text).toContain('ticket.title');
    expect(text).toContain('2 internal comment(s) and the internal description');
    expect(res.structuredContent).toMatchObject({ excluded: { internalComments: 2, internalDescription: true } });
  });
});
