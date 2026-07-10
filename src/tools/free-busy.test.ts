import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OrbotoClient } from '../orboto-client.js';
import { makeFreeBusyHandler } from './free-busy.js';

beforeEach(() => { vi.restoreAllMocks(); });
afterEach(() => { vi.restoreAllMocks(); });

function stub(responses: Array<{ status?: number; json?: unknown }>) {
  const calls: string[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
    calls.push(url.toString());
    const r = responses.shift();
    if (!r) throw new Error(`unexpected extra fetch to ${url}`);
    const status = r.status ?? 200;
    return { ok: status < 400, status, statusText: 'x', json: async () => ('json' in r ? r.json : {}), text: async () => '' } as unknown as Response;
  });
  return calls;
}

const client = new OrbotoClient({ baseUrl: 'https://orboto.example.com', apiKey: 'orb_x' });
const U1 = '11111111-1111-1111-1111-111111111111';
const U2 = '22222222-2222-2222-2222-222222222222';

describe('orboto_free_busy (ORB-625)', () => {
  it('batches the user-ids into a single GET /users/free-busy call', async () => {
    const payload = { users: [{ userId: U1, entries: [], status: 'available' }, { userId: U2, entries: [], status: 'busy' }] };
    const calls = stub([{ json: payload }]);
    const res = await makeFreeBusyHandler(client)({ userIds: [U1, U2] });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('/users/free-busy?');
    expect(calls[0]).toContain(`userIds=${encodeURIComponent(`${U1},${U2}`)}`);
    expect((res.structuredContent as typeof payload).users).toHaveLength(2);
    expect((res.structuredContent as typeof payload).users[0]).toMatchObject({ userId: U1, status: 'available' });
  });

  it('passes the window + granularity through', async () => {
    const calls = stub([{ json: { users: [] } }]);
    await makeFreeBusyHandler(client)({ userIds: [U1], from: '2026-07-01', to: '2026-07-14', granularity: 'week' });
    expect(calls[0]).toContain('from=2026-07-01');
    expect(calls[0]).toContain('to=2026-07-14');
    expect(calls[0]).toContain('granularity=week');
  });

  it('returns a readable not-permitted result on 403 (workspace toggle off)', async () => {
    stub([{ status: 403, json: { error: 'Free/busy availability is disabled for this workspace.' } }]);
    const res = await makeFreeBusyHandler(client)({ userIds: [U1] });
    expect(res.structuredContent).toMatchObject({ error: 'forbidden' });
    const first = res.content[0] as { type: string; text?: string };
    expect(String(first.text)).toMatch(/not permitted/i);
  });
});
