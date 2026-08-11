/**
 * ORB-1519 - unit tests for `orboto_api_call`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OrbotoClient } from '../orboto-client.js';
import { makeApiCallHandler } from './api-call.js';

beforeEach(() => { vi.restoreAllMocks(); });
afterEach(() => { vi.restoreAllMocks(); });

function stub(responses: Array<{ ok?: boolean; status?: number; json?: unknown; text?: string }>) {
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
      text: async () => r.text ?? '',
    } as unknown as Response;
  });
  return calls;
}

const client = new OrbotoClient({ baseUrl: 'https://orboto.example.com', apiKey: 'orb_x' });

describe('orboto_api_call', () => {
  it('POSTs the structured request to /system/api-proxy and renders the envelope', async () => {
    const calls = stub([{
      json: {
        status: 201,
        contentType: 'application/json',
        body: { id: 'm1', name: 'M' },
        encoding: 'json',
        truncated: false,
        matchedRoute: '/projects/{projectId}/milestones',
      },
    }]);
    const res = await makeApiCallHandler(client)({
      method: 'POST',
      path: '/projects/p1/milestones',
      body: { name: 'M', startDate: null, endDate: null },
    });
    expect(calls[0].url).toContain('/system/api-proxy');
    expect(calls[0].body).toMatchObject({ method: 'POST', path: '/projects/p1/milestones' });
    expect(res.isError).toBeUndefined();
    expect((res.content[0] as { text: string }).text).toContain('HTTP 201');
    expect((res.structuredContent as { status: number }).status).toBe(201);
  });

  it('surfaces an inner 403 as data with a permission hint', async () => {
    stub([{
      json: {
        status: 403,
        contentType: 'application/json',
        body: { error: 'Forbidden', errorKey: 'errors.permissions.forbidden' },
        encoding: 'json',
        truncated: false,
        matchedRoute: '/projects/{projectId}/milestones',
      },
    }]);
    const res = await makeApiCallHandler(client)({ method: 'POST', path: '/projects/p1/milestones', body: {} });
    expect(res.isError).toBeUndefined(); // the tool call succeeded; the API said no
    const text = (res.content[0] as { text: string }).text;
    expect(text).toContain('HTTP 403');
    expect(text).toMatch(/missing permission/i);
  });

  it('un-stringifies a client-stringified JSON body before posting (ORB-1710)', async () => {
    const calls = stub([{
      json: { status: 201, contentType: 'application/json', body: { ok: true }, encoding: 'json', truncated: false, matchedRoute: '/docs/{id}/append-section' },
    }]);
    await makeApiCallHandler(client)({
      method: 'POST',
      path: '/docs/abc/append-section',
      body: '{"content":"# heading"}',
    });
    // The proxy must receive real JSON, not a double-encoded string.
    expect((calls[0].body as { body: unknown }).body).toEqual({ content: '# heading' });
  });

  it('passes an unparseable string body through for the proxy\'s clear 400', async () => {
    const calls = stub([{
      json: { status: 400, contentType: 'application/json', body: { errorKey: 'errors.api_proxy.invalid_body' }, encoding: 'json', truncated: false, matchedRoute: '/x' },
    }]);
    await makeApiCallHandler(client)({ method: 'POST', path: '/projects', body: 'not json' });
    expect((calls[0].body as { body: unknown }).body).toBe('not json');
  });

  it('forwards query params', async () => {
    const calls = stub([{
      json: { status: 200, contentType: 'application/json', body: [], encoding: 'json', truncated: false, matchedRoute: '/projects' },
    }]);
    await makeApiCallHandler(client)({ method: 'GET', path: '/projects', query: { limit: 5 } });
    expect(calls[0].body).toMatchObject({ query: { limit: 5 } });
  });

  it('marks a truncated envelope in the text output', async () => {
    stub([{
      json: { status: 200, contentType: 'text/plain', body: 'x'.repeat(50), encoding: 'utf8', truncated: true, matchedRoute: '/export' },
    }]);
    const res = await makeApiCallHandler(client)({ method: 'GET', path: '/export' });
    expect((res.content[0] as { text: string }).text).toContain('truncated by the proxy cap');
  });
});
