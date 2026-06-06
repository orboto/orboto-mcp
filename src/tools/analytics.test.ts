import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { OrbotoClient } from '../orboto-client.js';
import { makeAnalyticsHandler } from './analytics.js';

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
const PROJ = { id: 'p1', key: 'ACME', name: 'Acme', description: '', status: 'active' };

describe('orboto_analytics (ORB-1032)', () => {
  it('routes a plain report to the analytics endpoint', async () => {
    const calls = stub([{ json: PROJ }, { json: { total: 5 } }]);
    const res = await makeAnalyticsHandler(client)({ projectKey: 'ACME', report: 'overview' });
    expect(calls[1]).toContain('/projects/p1/analytics/overview');
    expect(res.structuredContent).toMatchObject({ report: 'overview', projectKey: 'ACME', data: { total: 5 } });
  });

  it('resolves a milestone + mode for earned-value', async () => {
    const calls = stub([{ json: PROJ }, { json: [{ id: 'm2', name: 'Sprint 7' }] }, { json: { available: true } }]);
    await makeAnalyticsHandler(client)({ projectKey: 'ACME', report: 'earned-value', milestone: 'Sprint 7', mode: 'money' });
    expect(calls[2]).toContain('/projects/p1/earned-value');
    expect(calls[2]).toContain('milestoneId=m2');
    expect(calls[2]).toContain('mode=money');
  });

  it('surfaces a permission error as a forbidden envelope (not a throw)', async () => {
    stub([{ json: PROJ }, { status: 403 }]);
    const res = await makeAnalyticsHandler(client)({ projectKey: 'ACME', report: 'budget' });
    expect(res.structuredContent).toMatchObject({ error: 'forbidden', requiredPermission: 'budget:view' });
    expect((res.content[0] as { text: string }).text).toMatch(/budget:view/);
  });
});
