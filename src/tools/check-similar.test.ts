/**
 * ORB-887 — unit tests for `orboto_check_similar`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OrbotoApiError, OrbotoClient } from '../orboto-client.js';
import { makeCheckSimilarHandler } from './check-similar.js';

beforeEach(() => { vi.restoreAllMocks(); });
afterEach(() => { vi.restoreAllMocks(); });

function stub(responses: Array<{ ok?: boolean; status?: number; json?: unknown }>) {
  const calls: Array<{ url: string; method: string; body?: unknown }> = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    calls.push({
      url: url.toString(),
      method: init?.method ?? 'GET',
      body: init?.body ? JSON.parse(init.body as string) : undefined,
    });
    const r = responses.shift();
    if (!r) throw new Error('unexpected extra fetch');
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

describe('orboto_check_similar', () => {
  it('returns a safe-to-create recommendation when no candidates match', async () => {
    const calls = stub([
      { json: PROJ },
      { json: { candidates: [], mode: 'tsvector' } },
    ]);
    const res = await makeCheckSimilarHandler(client)({
      projectKey: 'ACME', title: 'Brand new scope',
    });
    expect(calls[1].url).toContain('/projects/p1/tickets/similar?');
    expect(calls[1].url).toContain('title=Brand+new+scope');
    const sc = res.structuredContent as { recommendation: string; similar: unknown[] };
    expect(sc.recommendation).toMatch(/safe to create/i);
    expect(sc.similar).toHaveLength(0);
  });

  it('flags a HIGH-SIMILARITY MATCH when the top hit ≥ 0.9', async () => {
    stub([
      { json: PROJ },
      {
        json: {
          mode: 'embedding',
          candidates: [
            { id: 't42', ticketKey: 'ACME-42', title: 'Existing auth work', statusName: 'In Progress', statusColor: '#fc0', statusCategory: 'in_progress', similarity: 0.94, matchMode: 'embedding' },
          ],
        },
      },
    ]);
    const res = await makeCheckSimilarHandler(client)({
      projectKey: 'ACME', title: 'Authentication overhaul', description: 'rewrite SSO',
    });
    const sc = res.structuredContent as { recommendation: string };
    expect(sc.recommendation).toMatch(/HIGH-SIMILARITY MATCH FOUND/);
    expect(sc.recommendation).toContain('ACME-42');
  });

  it('returns the medium recommendation when the top hit is < 0.9', async () => {
    stub([
      { json: PROJ },
      {
        json: {
          mode: 'tsvector',
          candidates: [
            { id: 't9', ticketKey: 'ACME-9', title: 'Loose match', statusName: 'Done', statusColor: '#7d7', statusCategory: 'done', similarity: 0.55, matchMode: 'tsvector' },
          ],
        },
      },
    ]);
    const res = await makeCheckSimilarHandler(client)({
      projectKey: 'ACME', title: 'Unrelated effort',
    });
    const sc = res.structuredContent as { recommendation: string };
    expect(sc.recommendation).toMatch(/Possible related tickets/);
  });

  it('passes description through to the query string when provided', async () => {
    const calls = stub([
      { json: PROJ },
      { json: { candidates: [], mode: 'tsvector' } },
    ]);
    await makeCheckSimilarHandler(client)({
      projectKey: 'ACME', title: 'foo', description: 'some long body',
    });
    expect(calls[1].url).toContain('description=some+long+body');
  });

  it('surfaces a 403 from the API as an OrbotoApiError', async () => {
    stub([
      { json: PROJ },
      { ok: false, status: 403, json: { error: 'Forbidden — missing ticket:create' } },
    ]);
    await expect(
      makeCheckSimilarHandler(client)({ projectKey: 'ACME', title: 'x' }),
    ).rejects.toBeInstanceOf(OrbotoApiError);
  });
});
