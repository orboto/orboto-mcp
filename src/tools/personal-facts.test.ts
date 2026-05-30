/**
 * ORB-862 — personal-fact MCP tools route to the owner-scoped endpoints.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OrbotoClient } from '../orboto-client.js';
import {
  makePersonalFactListHandler, makePersonalFactAddHandler,
  makePersonalFactUpdateHandler, makePersonalFactDeleteHandler,
} from './personal-facts.js';

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
const ID = 'p0000000-0000-0000-0000-000000000001';

describe('personal-fact MCP tools (ORB-862)', () => {
  it('list hits GET /users/me/primer-facts', async () => {
    const calls = stubJSON([{ json: [{ id: ID, category: 'conventions', key: 'tone', value: 'terse' }] }]);
    const res = await makePersonalFactListHandler(client)();
    expect(calls[0].url).toBe('https://orboto.example.com/users/me/primer-facts');
    expect((res.content[0] as { text: string }).text).toContain('tone: terse');
  });
  it('add POSTs the fact', async () => {
    const calls = stubJSON([{ status: 201, json: { id: ID, key: 'tone' } }]);
    await makePersonalFactAddHandler(client)({ category: 'conventions', key: 'tone', value: 'terse' });
    expect(calls[0]).toMatchObject({ method: 'POST', url: 'https://orboto.example.com/users/me/primer-facts', body: { category: 'conventions', key: 'tone', value: 'terse' } });
  });
  it('update PATCHes by id', async () => {
    const calls = stubJSON([{ json: { id: ID, key: 'tone' } }]);
    await makePersonalFactUpdateHandler(client)({ id: ID, value: 'very terse' });
    expect(calls[0]).toMatchObject({ method: 'PATCH', url: `https://orboto.example.com/users/me/primer-facts/${ID}`, body: { value: 'very terse' } });
  });
  it('delete DELETEs by id', async () => {
    const calls = stubJSON([{ status: 204 }]);
    const res = await makePersonalFactDeleteHandler(client)({ id: ID });
    expect(calls[0]).toMatchObject({ method: 'DELETE', url: `https://orboto.example.com/users/me/primer-facts/${ID}` });
    expect((res.content[0] as { text: string }).text).toBe('Deleted.');
  });
});
