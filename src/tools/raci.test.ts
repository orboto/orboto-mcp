import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { OrbotoClient } from '../orboto-client.js';
import { makeRaciHandler, makeSetRaciHandler } from './raci.js';

beforeEach(() => { vi.restoreAllMocks(); });
afterEach(() => { vi.restoreAllMocks(); });

function stub(responses: Array<{ status?: number; json?: unknown; text?: string }>) {
  const calls: Array<{ url: string; method: string }> = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    calls.push({ url: url.toString(), method: (init?.method as string) ?? 'GET' });
    const r = responses.shift();
    if (!r) throw new Error(`unexpected extra fetch to ${url}`);
    const status = r.status ?? 200;
    return {
      ok: status < 400,
      status,
      statusText: 'x',
      json: async () => ('json' in r ? r.json : {}),
      text: async () => r.text ?? (r.json ? JSON.stringify(r.json) : ''),
    } as unknown as Response;
  });
  return calls;
}

const client = new OrbotoClient({ baseUrl: 'https://orboto.example.com', apiKey: 'orb_x' });
const PROJ = { id: 'p1', key: 'ACME', name: 'Acme', description: '', status: 'active' };
const TICKET = { id: 't1', projectId: 'p1', ticketKey: 'ACME-42', title: 'Thing', type: 'task' };
const MEMBERS = [{ userId: 'u1', user: { email: 'dana@x.io', fullName: 'Dana' } }];

describe('orboto_set_raci (ORB-1037)', () => {
  it('resolves ticket + member and PUTs the role', async () => {
    const calls = stub([{ json: PROJ }, { json: TICKET }, { json: MEMBERS }, { json: { ok: true, role: 'A' } }]);
    const res = await makeSetRaciHandler(client)({ ticketKey: 'ACME-42', userEmail: 'dana@x.io', role: 'A' });
    const put = calls.find((c) => c.method === 'PUT')!;
    expect(put.url).toContain('/projects/p1/tickets/t1/raci/u1');
    expect(res.structuredContent).toMatchObject({ ticketKey: 'ACME-42', userEmail: 'dana@x.io', role: 'A' });
  });

  it('surfaces a single-Accountable 409 as a conflict envelope, not a throw', async () => {
    stub([
      { json: PROJ },
      { json: TICKET },
      { json: MEMBERS },
      { status: 409, json: { error: 'This ticket already has an Accountable (Tom). Change their role first.' } },
    ]);
    const res = await makeSetRaciHandler(client)({ ticketKey: 'ACME-42', userEmail: 'dana@x.io', role: 'A' });
    expect(res.structuredContent).toMatchObject({ error: 'conflict' });
    expect((res.content[0] as { text: string }).text).toMatch(/already has an Accountable/);
  });
});

describe('orboto_raci (ORB-1037)', () => {
  it('reads the matrix and renders one line per ticket', async () => {
    const calls = stub([
      { json: PROJ },
      {
        json: {
          raciEnabled: true,
          members: [{ userId: 'u1', fullName: 'Dana', email: 'dana@x.io' }],
          rows: [{ ticketId: 't1', ticketKey: 'ACME-42', title: 'Thing', cells: { u1: 'A' } }],
        },
      },
    ]);
    const res = await makeRaciHandler(client)({ projectKey: 'ACME' });
    expect(calls[1].url).toContain('/projects/p1/raci-matrix');
    expect((res.content[0] as { text: string }).text).toMatch(/ACME-42/);
    expect((res.content[0] as { text: string }).text).toMatch(/A:Dana/);
  });

  it('reports the disabled state', async () => {
    stub([{ json: PROJ }, { json: { raciEnabled: false, members: [], rows: [] } }]);
    const res = await makeRaciHandler(client)({ projectKey: 'ACME' });
    expect(res.structuredContent).toMatchObject({ raciEnabled: false });
  });
});
