/** ORB-2272 - the MCP releases the capacity claims of its agent session: granted ones on may_stop, every one with sessionEnd and at session end. */
import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import type { OrbotoClient } from '../orboto-client.js';
import { OrbotoApiError } from '../orboto-client.js';
import { makeSessionCheckHandler } from './session-check.js';
import { releaseCapacityAtSessionEnd, releaseCapacityOnStdinEnd, releaseSessionCapacity } from './capacity-session.js';

const GRANTED = { id: 'c-granted', resourceName: 'build-host:runner-1', state: 'granted' };
const QUEUED = { id: 'c-queued', resourceName: 'unity:mac-1', state: 'queued' };

function fakeClient(verdict: 'continue' | 'may_stop', opts: { failRelease?: string } = {}) {
  const released: Array<{ id: string; reason: string; token?: string }> = [];
  const listed: string[] = [];
  const get = vi.fn(async (path: string) => {
    if (path === '/agents/session/unfinished') return { sessionId: 'sess-uuid', verdict, reason: verdict, text: `verdict ${verdict}` };
    if (path.startsWith('/capacity/claims?')) {
      listed.push(path);
      const cursor = new URLSearchParams(path.split('?')[1]).get('cursor');
      return cursor ? { items: [QUEUED], nextCursor: null } : { items: [GRANTED], nextCursor: 'page-2' };
    }
    throw new Error(`unexpected GET ${path}`);
  });
  const post = vi.fn(async (path: string, body: { reason: string }, o?: { instanceToken?: string }) => {
    const id = path.split('/')[3]!;
    if (id === opts.failRelease) throw new OrbotoApiError(403, '{"error":"claim_not_yours"}', path);
    released.push({ id, reason: body.reason, token: o?.instanceToken });
    return { id, state: 'released' };
  });
  return { client: { get, post } as unknown as OrbotoClient, released, listed, get };
}

describe('ORB-2272 - orboto_session_check releases the session\'s capacity claims', () => {
  it('may_stop releases the granted claim and keeps the queued one', async () => {
    const api = fakeClient('may_stop');
    const res = await makeSessionCheckHandler(api.client)({ action: 'check' }, { sessionId: 'http-1' });
    expect(api.released.map((r) => r.id)).toEqual(['c-granted']);
    expect(api.released[0]).toMatchObject({ reason: 'completion check: may_stop', token: 'mcp-http-1' });
    expect(api.listed[0]).toContain('holderKind=agent-session');
    expect(api.listed[0]).toContain('holderId=sess-uuid');
    expect(api.listed[0]).toContain('active=true');
    expect((res.content[0] as { text: string }).text).toContain('build-host:runner-1 (granted, c-granted)');
    expect(res.structuredContent).toMatchObject({ verdict: 'may_stop', capacityReleased: [{ id: 'c-granted', was: 'granted' }], capacityReleaseFailed: [] });
  });

  it('continue releases nothing and does not even list claims', async () => {
    const api = fakeClient('continue');
    const res = await makeSessionCheckHandler(api.client)({});
    expect(api.released).toEqual([]);
    expect(api.listed).toEqual([]);
    expect(res.structuredContent).not.toHaveProperty('capacityReleased');
  });

  it('sessionEnd releases the granted and the queued claim, whatever the verdict', async () => {
    const api = fakeClient('continue');
    const res = await makeSessionCheckHandler(api.client)({ action: 'check', sessionEnd: true });
    expect(api.released.map((r) => [r.id, r.reason])).toEqual([['c-granted', 'agent session ended'], ['c-queued', 'agent session ended']]);
    expect(res.structuredContent).toMatchObject({ capacityReleased: [{ id: 'c-granted', was: 'granted' }, { id: 'c-queued', was: 'queued' }] });
  });

  it('a refused release is reported and never stops the others', async () => {
    const api = fakeClient('may_stop', { failRelease: 'c-granted' });
    const res = await releaseSessionCapacity(api.client, 'sess-uuid', 'all', 'agent session ended');
    expect(res.released.map((r) => r.id)).toEqual(['c-queued']);
    expect(res.failed).toEqual([expect.objectContaining({ id: 'c-granted', error: expect.stringContaining('403') })]);
  });
});

describe('ORB-2272 - the MCP session end releases every claim of the session', () => {
  it('resolves the session behind the instance token and releases granted and queued claims', async () => {
    const api = fakeClient('continue');
    const res = await releaseCapacityAtSessionEnd(api.client, 'mcp-proc');
    expect(api.get).toHaveBeenCalledWith('/agents/session/unfinished', { instanceToken: 'mcp-proc' });
    expect(res?.released.map((r) => r.id)).toEqual(['c-granted', 'c-queued']);
    expect(api.released.every((r) => r.token === 'mcp-proc')).toBe(true);
  });

  it('gives up at the deadline instead of holding the session end open', async () => {
    const get = vi.fn(() => new Promise(() => undefined));
    const started = Date.now();
    expect(await releaseCapacityAtSessionEnd({ get, post: vi.fn() } as unknown as OrbotoClient, 'mcp-proc', 20)).toBeNull();
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('never throws when the session is unknown', async () => {
    const get = vi.fn().mockRejectedValue(new OrbotoApiError(404, 'instance_session_not_found', '/agents/session/unfinished'));
    expect(await releaseCapacityAtSessionEnd({ get, post: vi.fn() } as unknown as OrbotoClient, 'mcp-proc')).toBeNull();
  });

  it('stdio: stdin end releases once, and the probe exit awaits the same run', async () => {
    const api = fakeClient('continue');
    const stdin = new EventEmitter();
    const run = releaseCapacityOnStdinEnd(stdin, api.client, 'mcp-proc');
    stdin.emit('end');
    stdin.emit('close');
    await run();
    expect(api.released.map((r) => r.id)).toEqual(['c-granted', 'c-queued']);
    expect(api.get.mock.calls.filter(([p]) => p === '/agents/session/unfinished')).toHaveLength(1);
  });
});
