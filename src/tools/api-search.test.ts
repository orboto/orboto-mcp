/**
 * ORB-1518 - unit tests for `orboto_api_search`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OrbotoClient } from '../orboto-client.js';
import { makeApiSearchHandler } from './api-search.js';

beforeEach(() => { vi.restoreAllMocks(); });
afterEach(() => { vi.restoreAllMocks(); });

function stub(responses: Array<{ ok?: boolean; status?: number; json?: unknown }>) {
  const calls: Array<{ url: string; method: string }> = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    calls.push({ url: url.toString(), method: init?.method ?? 'GET' });
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

const ENTRY = {
  method: 'POST',
  path: '/projects/{projectId}/milestones',
  summary: 'Create a milestone',
  tags: ['Milestones'],
  requiredPermissions: ['milestone:create'],
  pathParams: ['projectId'],
  queryParams: [],
  bodyProps: ['name', 'startDate', 'endDate', 'isPrivate?'],
  score: 12,
};

describe('orboto_api_search', () => {
  it('search mode hits /system/api-catalog and renders matches with permissions', async () => {
    const calls = stub([{ json: { query: 'create milestone', total: 1, results: [ENTRY] } }]);
    const res = await makeApiSearchHandler(client)({ query: 'create milestone' });
    expect(calls[0].url).toContain('/system/api-catalog?');
    expect(calls[0].url).toContain('q=create+milestone');
    expect(res.isError).toBeUndefined();
    const text = (res.content[0] as { text: string }).text;
    expect(text).toContain('POST /projects/{projectId}/milestones');
    expect(text).toContain('milestone:create');
    expect((res.structuredContent as { total: number }).total).toBe(1);
  });

  it('detail mode hits /operation with path + method', async () => {
    const calls = stub([{
      json: {
        method: 'POST',
        path: '/projects/{projectId}/milestones',
        summary: 'Create a milestone',
        description: null,
        tags: ['Milestones'],
        requiredPermissions: ['milestone:create'],
        parameters: [{ name: 'projectId', in: 'path', required: true }],
        requestBody: { type: 'object', required: ['name'], properties: { name: { type: 'string' } } },
        responses: { '200': { type: 'object' } },
      },
    }]);
    const res = await makeApiSearchHandler(client)({
      path: '/projects/{projectId}/milestones',
      method: 'POST',
    });
    expect(calls[0].url).toContain('/system/api-catalog/operation?');
    expect(calls[0].url).toContain('method=POST');
    const sc = res.structuredContent as { requestBody: { required: string[] } };
    expect(sc.requestBody.required).toContain('name');
    expect((res.content[0] as { text: string }).text).toContain('requires: milestone:create');
  });

  it('rejects detail mode without a method', async () => {
    stub([]);
    const res = await makeApiSearchHandler(client)({ path: '/projects' });
    expect(res.isError).toBe(true);
  });

  it('rejects a call with neither query nor path', async () => {
    stub([]);
    const res = await makeApiSearchHandler(client)({});
    expect(res.isError).toBe(true);
  });

  it('renders an empty-result hint instead of erroring', async () => {
    stub([{ json: { query: 'xyzzy', total: 0, results: [] } }]);
    const res = await makeApiSearchHandler(client)({ query: 'xyzzy' });
    expect(res.isError).toBeUndefined();
    expect((res.content[0] as { text: string }).text).toMatch(/no endpoints match/i);
  });
});
