/** ORB-2272 - build capacity for an MCP-only agent: the escape hatch carries list, claim, renew, release and windows, labelled in the metrics and held to the response budget. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OrbotoClient } from '../orboto-client.js';
import { withMetrics } from '../with-metrics.js';
import { metricsToolName, TAIL_LABELS } from '../tail-labels.js';
import { makeApiCallHandler } from './api-call.js';
import { makeHelpHandler } from './help.js';

const CLAIM = '6f1c2b1e-3d4a-4b5c-8d9e-0a1b2c3d4e5f';

interface Envelope { status: number; body: unknown }

function mockApi(answer: (proxied: { method: string; path: string; query?: unknown; body?: unknown }) => Envelope) {
  const instrument: Array<Record<string, unknown>> = [];
  const proxied: Array<{ method: string; path: string; headers: Record<string, string> }> = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    const u = url.toString();
    if (u.endsWith('/admin/mcp/instrument')) {
      instrument.push(body);
      return new Response(JSON.stringify({ id: CLAIM }), { status: 201, headers: { 'content-type': 'application/json' } });
    }
    if (u.endsWith('/system/api-proxy')) {
      proxied.push({ method: body.method, path: body.path, headers: init?.headers as Record<string, string> });
      const { status, body: inner } = answer(body);
      return new Response(JSON.stringify({ status, contentType: 'application/json', body: inner, encoding: 'json', truncated: false, matchedRoute: `${body.method} ${body.path}` }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response('not mocked', { status: 500 });
  });
  return { instrument, proxied };
}

const client = new OrbotoClient({ baseUrl: 'https://orboto.example.com', apiKey: 'orb_test' });
const apiCall = withMetrics(client, 'orboto_api_call', undefined, makeApiCallHandler(client));
const flush = () => new Promise((r) => setTimeout(r, 0));

const claimRow = (state: string) => ({ id: CLAIM, resourceName: 'build-host:runner-1', holderKind: 'agent-session', state, position: state === 'queued' ? 1 : null });

beforeEach(() => { vi.restoreAllMocks(); });
afterEach(() => { vi.restoreAllMocks(); });

describe('ORB-2272 - capacity through orboto_api_call', () => {
  it('claims, renews and releases as this MCP session and labels each call with its capacity tool', async () => {
    const { instrument, proxied } = mockApi(({ method, path }) => {
      if (method === 'POST' && path === '/capacity/claims') return { status: 201, body: { ...claimRow('granted'), holders: [] } };
      if (path.endsWith('/renew')) return { status: 200, body: claimRow('granted') };
      if (path.endsWith('/release')) return { status: 200, body: claimRow('released') };
      return { status: 200, body: { items: [claimRow('granted')], nextCursor: null } };
    });
    const extra = { sessionId: 'sess-1' };
    const claimed = await apiCall({ method: 'POST', path: '/capacity/claims', body: { resource: 'build-host:runner-1', reason: 'release build', expectedMinutes: 45, priority: 'release' } }, extra);
    expect(claimed.isError).toBeUndefined();
    expect(claimed.structuredContent).toMatchObject({ status: 201, body: { state: 'granted', holderKind: 'agent-session' } });
    await apiCall({ method: 'POST', path: `/capacity/claims/${CLAIM}/renew`, body: {} }, extra);
    await apiCall({ method: 'GET', path: '/capacity/resources/build-host:runner-1' }, extra);
    await apiCall({ method: 'GET', path: '/capacity/windows' }, extra);
    const released = await apiCall({ method: 'POST', path: `/capacity/claims/${CLAIM}/release`, body: {} }, extra);
    expect(released.structuredContent).toMatchObject({ status: 200, body: { state: 'released' } });
    await flush();
    expect(proxied.every((p) => p.headers['x-orboto-agent-session'] === 'mcp-sess-1')).toBe(true);
    expect(instrument.map((e) => [e.toolName, e.success])).toEqual([
      ['orboto_capacity_claim', true],
      ['orboto_capacity_renew', true],
      ['orboto_capacity_list', true],
      ['orboto_capacity_windows', true],
      ['orboto_capacity_release', true],
    ]);
  });

  it('a 403 comes back as data and counts as a failed orboto_capacity_release with its status', async () => {
    const { instrument } = mockApi(() => ({ status: 403, body: { error: 'claim_not_yours', message: 'This claim belongs to another account.' } }));
    const res = await apiCall({ method: 'POST', path: `/capacity/claims/${CLAIM}/release`, body: {} });
    const text = (res.content[0] as { text: string }).text;
    expect(text).toContain('HTTP 403');
    expect(text).toContain('403 = missing permission');
    expect(res.structuredContent).toMatchObject({ status: 403, body: { error: 'claim_not_yours' } });
    await flush();
    expect(instrument).toEqual([expect.objectContaining({ toolName: 'orboto_capacity_release', success: false, statusCode: 403 })]);
  });

  it('a 404 on an unknown resource comes back as data and counts as a failed orboto_capacity_claim', async () => {
    const { instrument } = mockApi(() => ({ status: 404, body: { error: 'capacity_resource_not_found' } }));
    const res = await apiCall({ method: 'POST', path: '/capacity/claims', body: { resource: 'gpu-farm', reason: 'x', expectedMinutes: 5 } });
    expect((res.content[0] as { text: string }).text).toContain('HTTP 404');
    await flush();
    expect(instrument).toEqual([expect.objectContaining({ toolName: 'orboto_capacity_claim', success: false, statusCode: 404 })]);
  });

  it('a long claim list is cut to the api_call budget with an expand handle, never silently', async () => {
    const items = Array.from({ length: 80 }, (_, i) => ({ ...claimRow('queued'), id: `${CLAIM.slice(0, -2)}${String(i).padStart(2, '0')}`, reason: 'nightly unity build '.repeat(6) }));
    const { instrument } = mockApi(() => ({ status: 200, body: { items, nextCursor: 'next' } }));
    const res = await apiCall({ method: 'GET', path: '/capacity/claims', query: { active: true } });
    const text = (res.content[0] as { text: string }).text;
    expect(text).toContain('orboto_response_expand');
    expect((res.structuredContent as { __truncation?: { handle?: string } }).__truncation?.handle).toBeTruthy();
    await flush();
    expect(instrument[0]).toMatchObject({ toolName: 'orboto_capacity_list', success: true });
    expect(Number(instrument[0]!.truncatedChars)).toBeGreaterThan(0);
  });
});

describe('ORB-2272 - metrics labels of the capacity tail', () => {
  it('maps every capacity route an agent calls and leaves everything else as orboto_api_call', () => {
    const cases: Array<[string, string, string]> = [
      ['GET', '/capacity/resources', 'orboto_capacity_list'],
      ['GET', '/capacity/resources/build-host:runner-1', 'orboto_capacity_list'],
      ['GET', '/capacity/resources/build-host:runner-1/queue', 'orboto_capacity_list'],
      ['GET', '/capacity/claims', 'orboto_capacity_list'],
      ['GET', `/capacity/claims/${CLAIM}`, 'orboto_capacity_list'],
      ['post', '/capacity/claims/', 'orboto_capacity_claim'],
      ['POST', `/capacity/claims/${CLAIM}/renew`, 'orboto_capacity_renew'],
      ['POST', `/capacity/claims/${CLAIM}/release`, 'orboto_capacity_release'],
      ['GET', '/capacity/windows', 'orboto_capacity_windows'],
      ['GET', '/capacity/resources/build-host:runner-1/plan', 'orboto_capacity_plan'],
      ['POST', '/capacity/resources/unity:build/plan?book=true', 'orboto_capacity_plan'],
      ['POST', '/capacity/seeds/nightly-unity', 'orboto_capacity_seed'],
      ['POST', '/capacity/seeds/other', 'orboto_api_call'],
      ['POST', '/capacity/resources', 'orboto_api_call'],
      ['POST', `/capacity/claims/${CLAIM}/yield`, 'orboto_api_call'],
      ['GET', '/capacity', 'orboto_api_call'],
      ['GET', '/projects', 'orboto_api_call'],
    ];
    for (const [method, path, label] of cases) expect(metricsToolName('orboto_api_call', { method, path }), `${method} ${path}`).toBe(label);
    expect(metricsToolName('orboto_get_ticket', { method: 'POST', path: '/capacity/claims' })).toBe('orboto_get_ticket');
    expect(new Set(TAIL_LABELS.map((l) => l.label))).toEqual(new Set(['orboto_capacity_list', 'orboto_capacity_claim', 'orboto_capacity_renew', 'orboto_capacity_release', 'orboto_capacity_windows', 'orboto_capacity_plan', 'orboto_capacity_seed']));
  });
});

describe('ORB-2272 - orboto_help topic capacity', () => {
  it('serves the claim, renew, release, windows and plan recipes', async () => {
    const res = await makeHelpHandler()({ topic: 'capacity' });
    const text = (res.content[0] as { text: string }).text;
    for (const needle of ['"path":"/capacity/claims"', '/renew', '/release', '/capacity/windows', '/plan', '"book":true', 'graceMinutes', 'capacity plan <resource> --for 45m --book', 'sessionEnd', '?toolset=full', 'ORBOTO_MCP_TOOLSET=full', 'capacity-holds', 'A curated agent has no orboto_session_check', 'session-check --session-end', '/capacity/seeds/nightly-unity', 'capacity wait <claimId> --hold -- <command...>', 'takes no slot']) expect(text).toContain(needle);
  });
});
