/** ORB-2264 - orboto_who reads the live directory. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OrbotoClient } from '../orboto-client.js';
import { agentWhoToolConfig, makeAgentWhoHandler, whoLine } from './agent-who.js';

afterEach(() => { vi.restoreAllMocks(); });

const client = new OrbotoClient({ baseUrl: 'https://orboto.example.com', apiKey: 'orb_test' });

const entry = {
  sessionId: 'f072e1c5-0000-4000-8000-000000000000', shortId: 'f072e1c5', email: 'claude@orboto.io', role: 'integrator',
  projectKeys: ['ORB'], addresses: ['integrator@ORB'], lastSeenAt: '2026-09-30T08:00:00Z',
  channel: { announced: 'claude-code', online: true }, currentTicket: { key: 'ORB-2264', title: 'mail' }, status: 'working',
};

describe('orboto_who', () => {
  it('GETs /v1/agent/who with the filters and prints one line per session', async () => {
    const urls: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      urls.push(String(url));
      return { ok: true, status: 200, statusText: 'OK', text: async () => '', json: async () => ({ sessions: [entry] }) } as unknown as Response;
    });
    const result = await makeAgentWhoHandler(client)({ project: 'ORB', role: 'integrator' });
    expect(urls[0]).toBe('https://orboto.example.com/v1/agent/who?project=ORB&role=integrator&limit=4');
    expect((result.content[0] as { text: string }).text).toContain('integrator@ORB - claude@orboto.io session f072e1c5, working, claude-code online');
    expect(result.structuredContent).toMatchObject({ sessions: [expect.objectContaining({ shortId: 'f072e1c5' })] });
  });

  it('ORB-2548: a project that is unknown or not visible answers in one line instead of a raw 404', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => ({ ok: false, status: 404, statusText: 'Not Found', headers: new Headers(), text: async () => '{"errorKey":"errors.agents.message_project_not_found"}', json: async () => ({}) } as unknown as Response));
    const result = await makeAgentWhoHandler(client)({ project: 'gone' });
    expect(result.isError).toBeUndefined();
    expect((result.content[0] as { text: string }).text).toBe('Project "GONE" is unknown or not visible to you - no session is listed for it.');
    expect(result.structuredContent).toEqual({ sessions: [], nextCursor: null });
  });

  it('says a request would be refused when nobody matches, and is read-only', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => ({ ok: true, status: 200, statusText: 'OK', text: async () => '', json: async () => ({ sessions: [] }) } as unknown as Response));
    const result = await makeAgentWhoHandler(client)({});
    expect((result.content[0] as { text: string }).text).toContain('no_recipient');
    expect(agentWhoToolConfig.annotations.readOnlyHint).toBe(true);
    expect(whoLine({ ...entry, addresses: [], role: null, channel: { announced: null, online: false }, currentTicket: null })).toContain('no scope');
  });

  it('ORB-2465: names the host a live notice filters on', () => {
    expect(whoLine({ ...entry, host: 'build-host-a' })).toContain('session f072e1c5, host build-host-a, working');
  });

  it('ORB-2544: prints origin, state and a shared address, and passes the state filter', async () => {
    const line = whoLine({ ...entry, state: 'orphaned', sharedAddresses: ['integrator@ORB'], origin: { host: 'build-host', repo: 'sample-repo', pid: 4242, client: 'orboto-cli', clientVersion: '1.2.3', harness: 'claude-code', startedAt: '2026-10-16T08:00:00.000Z' } });
    expect(line).toContain('session f072e1c5 [orphaned] on build-host sample-repo pid 4242 claude-code orboto-cli 1.2.3 since 2026-10-16T08:00:00.000Z, working');
    expect(line).toContain('also held by another live session: integrator@ORB');
    const urls: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      urls.push(String(url));
      return { ok: true, status: 200, statusText: 'OK', text: async () => '', json: async () => ({ sessions: [] }) } as unknown as Response;
    });
    await makeAgentWhoHandler(client)({ state: 'unknown_origin' });
    expect(urls[0]).toBe('https://orboto.example.com/v1/agent/who?state=unknown_origin&limit=4');
  });
});
