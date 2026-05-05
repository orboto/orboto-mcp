/**
 * ORB-244 Phase A — Orbit REST client unit tests.
 *
 * We mock `fetch` and cover the shape we promise to every tool
 * handler: correct base URL, bearer header, User-Agent string,
 * JSON body for write verbs, and the `OrbitApiError` throw on
 * non-2xx with status + body captured.
 *
 * `preflightMcpSession` is tested too because its three-way
 * failure branching (401 / disabled / permission-denied) is the
 * most likely regression surface when the API contract drifts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OrbitClient, OrbitApiError, preflightMcpSession } from './orbit-client.js';

beforeEach(() => { vi.restoreAllMocks(); });
afterEach(() => { vi.restoreAllMocks(); });

function mockFetch(response: Partial<Response> & { json?: () => Promise<unknown>; text?: () => Promise<string> }) {
  const fullResponse = {
    ok: response.ok ?? true,
    status: response.status ?? 200,
    statusText: response.statusText ?? 'OK',
    json: response.json ?? (async () => ({})),
    text: response.text ?? (async () => ''),
  } as unknown as Response;
  return vi.spyOn(globalThis, 'fetch').mockResolvedValue(fullResponse);
}

describe('OrbitClient', () => {
  it('strips trailing slashes from baseUrl', async () => {
    const spy = mockFetch({ json: async () => ({ ok: true }) });
    const client = new OrbitClient({ baseUrl: 'https://orboto.example.com///', apiKey: 'orb_test' });
    await client.get('/projects');
    expect(spy).toHaveBeenCalledWith('https://orboto.example.com/projects', expect.any(Object));
  });

  it('prepends a missing leading slash on path', async () => {
    const spy = mockFetch({ json: async () => ({}) });
    const client = new OrbitClient({ baseUrl: 'https://orboto.example.com', apiKey: 'orb_test' });
    await client.get('projects');
    expect(spy).toHaveBeenCalledWith('https://orboto.example.com/projects', expect.any(Object));
  });

  it('sends Authorization: Bearer and User-Agent with optional client suffix', async () => {
    const spy = mockFetch({ json: async () => ({}) });
    const client = new OrbitClient({
      baseUrl: 'https://orboto.example.com',
      apiKey: 'orb_test',
      userAgentSuffix: 'claude-desktop',
    });
    await client.get('/projects');
    const [, init] = spy.mock.calls[0]!;
    const headers = (init as { headers: Record<string, string> }).headers;
    expect(headers.Authorization).toBe('Bearer orb_test');
    expect(headers['User-Agent']).toMatch(/^orbit-mcp\/[\d.]+ \(claude-desktop\)$/);
  });

  it('omits the UA suffix when userAgentSuffix is not set', async () => {
    const spy = mockFetch({ json: async () => ({}) });
    const client = new OrbitClient({ baseUrl: 'https://orboto.example.com', apiKey: 'orb_test' });
    await client.get('/projects');
    const [, init] = spy.mock.calls[0]!;
    const headers = (init as { headers: Record<string, string> }).headers;
    expect(headers['User-Agent']).toMatch(/^orbit-mcp\/[\d.]+$/);
  });

  it('serialises POST body as JSON with Content-Type', async () => {
    const spy = mockFetch({ json: async () => ({ created: true }) });
    const client = new OrbitClient({ baseUrl: 'https://orboto.example.com', apiKey: 'orb_test' });
    await client.post('/tickets', { title: 'x' });
    const [, init] = spy.mock.calls[0]!;
    expect((init as { method: string }).method).toBe('POST');
    expect((init as { body: string }).body).toBe('{"title":"x"}');
    expect((init as { headers: Record<string, string> }).headers['Content-Type']).toBe('application/json');
  });

  it('throws OrbitApiError with captured status + body on non-2xx', async () => {
    mockFetch({ ok: false, status: 403, text: async () => '{"error":"forbidden"}' });
    const client = new OrbitClient({ baseUrl: 'https://orboto.example.com', apiKey: 'orb_test' });
    await expect(client.get('/forbidden')).rejects.toMatchObject({
      name: 'OrbitApiError',
      status: 403,
      body: '{"error":"forbidden"}',
      url: 'https://orboto.example.com/forbidden',
    });
  });

  it('returns undefined (not null) for 204', async () => {
    mockFetch({ status: 204 });
    const client = new OrbitClient({ baseUrl: 'https://orboto.example.com', apiKey: 'orb_test' });
    const result = await client.post('/action', {});
    expect(result).toBeUndefined();
  });
});

describe('preflightMcpSession', () => {
  it('resolves {userEmail} when enabled + mcpUseGranted', async () => {
    mockFetch({ json: async () => ({ enabled: true, mcpUseGranted: true, userEmail: 'a@b.c' }) });
    const client = new OrbitClient({ baseUrl: 'https://orboto.example.com', apiKey: 'orb_test' });
    await expect(preflightMcpSession(client)).resolves.toEqual({ userEmail: 'a@b.c' });
  });

  it('throws a helpful message when the API returns 401 (bad token)', async () => {
    mockFetch({ ok: false, status: 401, text: async () => 'Invalid API key' });
    const client = new OrbitClient({ baseUrl: 'https://orboto.example.com', apiKey: 'orb_bad' });
    await expect(preflightMcpSession(client)).rejects.toThrow(/API key is invalid or expired/);
  });

  it('throws when the workspace has mcp_enabled=false', async () => {
    mockFetch({ json: async () => ({ enabled: false, mcpUseGranted: true, userEmail: 'a@b.c' }) });
    const client = new OrbitClient({ baseUrl: 'https://orboto.example.com', apiKey: 'orb_test' });
    await expect(preflightMcpSession(client)).rejects.toThrow(/administrator has disabled MCP/);
  });

  it('throws when the user lacks mcp:use', async () => {
    mockFetch({ json: async () => ({ enabled: true, mcpUseGranted: false, userEmail: 'a@b.c' }) });
    const client = new OrbitClient({ baseUrl: 'https://orboto.example.com', apiKey: 'orb_test' });
    await expect(preflightMcpSession(client)).rejects.toThrow(/lacks the mcp:use permission/);
  });

  it('propagates non-401 errors verbatim', async () => {
    mockFetch({ ok: false, status: 503, text: async () => 'Service unavailable' });
    const client = new OrbitClient({ baseUrl: 'https://orboto.example.com', apiKey: 'orb_test' });
    await expect(preflightMcpSession(client)).rejects.toBeInstanceOf(OrbitApiError);
  });
});
