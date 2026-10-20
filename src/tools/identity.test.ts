/**
 * ORB-799 - `orboto_whoami` unit tests.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OrbotoApiError, OrbotoClient } from '../orboto-client.js';
import { makeWhoamiHandler } from './identity.js';

beforeEach(() => { vi.restoreAllMocks(); });
afterEach(() => { vi.restoreAllMocks(); });

function stub(responses: Array<{ ok?: boolean; status?: number; json?: unknown }>) {
  const calls: Array<{ url: string; method: string }> = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    calls.push({ url: url.toString(), method: init?.method ?? 'GET' });
    const r = responses.shift();
    if (!r) throw new Error(`unexpected extra fetch`);
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

describe('orboto_whoami', () => {
  it('returns the authenticated user shape from /users/me', async () => {
    const calls = stub([
      { json: { id: 'u1', email: 'agent-e@orboto.io', fullName: 'Claude Agent E', isBot: true, workspaceLocale: 'en' } },
    ]);
    const res = await makeWhoamiHandler(client)();
    expect(calls[0].url).toBe('https://orboto.example.com/users/me');
    expect(calls[0].method).toBe('GET');
    expect(res.structuredContent).toEqual({
      id: 'u1',
      email: 'agent-e@orboto.io',
      fullName: 'Claude Agent E',
      isBot: true,
      workspaceLocale: 'en',
      actingAuthorizedBy: null,
      agentSession: null,
    });
    expect((res.content[0] as { text: string }).text).toContain('agent-e@orboto.io');
  });

  it('ORB-2550 - names the session the connection writes under, and a session another live process owns', async () => {
    const session = { id: '0b0c3a1e-7f73-4c55-8a4e-1d0f0f0f0f0f', label: 'mcp-stdio#0b0c3a1e', harness: 'claude-code', pid: 4242, foreign: false };
    stub([{ json: { id: 'u5', email: 'agent@orboto.io', isBot: true, agentSession: session } }, { json: { id: 'u5', email: 'agent@orboto.io', isBot: true, agentSession: { ...session, foreign: true } } }]);
    const own = await makeWhoamiHandler(client)();
    expect(own.structuredContent).toMatchObject({ agentSession: session });
    expect((own.content[0] as { text: string }).text).toContain(`session: ${session.id} (mcp-stdio#0b0c3a1e)`);
    const foreign = await makeWhoamiHandler(client)();
    expect((foreign.content[0] as { text: string }).text).toContain('owned by claude-code pid 4242, another process: writes carry no session, timers and work sessions are refused; give this process an instance token of its own (ORBOTO_AGENT_SESSION=<own value>)'); expect((foreign.content[0] as { text: string }).text).toContain('after a restart of the same harness, orboto session-start registers the row again');
  });

  it('surfaces workspaceLocale in the text output when present (ORB-989)', async () => {
    stub([{ json: { id: 'u4', email: 'agent@orboto.io', fullName: 'Agent', isBot: true, workspaceLocale: 'de' } }]);
    const res = await makeWhoamiHandler(client)();
    expect((res.content[0] as { text: string }).text).toContain('workspace language: de');
    expect(res.structuredContent).toMatchObject({ workspaceLocale: 'de' });
  });

  it('handles missing fullName + missing isBot flag (treats as not-a-bot)', async () => {
    stub([{ json: { id: 'u2', email: 'human@orboto.io' } }]);
    const res = await makeWhoamiHandler(client)();
    expect(res.structuredContent).toMatchObject({
      id: 'u2',
      email: 'human@orboto.io',
      fullName: null,
      isBot: false,
      workspaceLocale: null,
      actingAuthorizedBy: null,
    });
  });

  it('surfaces a 401 from the API as OrbotoApiError', async () => {
    stub([{ ok: false, status: 401, json: { error: 'invalid token' } }]);
    await expect(makeWhoamiHandler(client)()).rejects.toBeInstanceOf(OrbotoApiError);
  });
});
