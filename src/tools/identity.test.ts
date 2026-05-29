/**
 * ORB-799 — `orboto_whoami` unit tests.
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
    });
    expect((res.content[0] as { text: string }).text).toContain('agent-e@orboto.io');
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
    });
  });

  it('surfaces a 401 from the API as OrbotoApiError', async () => {
    stub([{ ok: false, status: 401, json: { error: 'invalid token' } }]);
    await expect(makeWhoamiHandler(client)()).rejects.toBeInstanceOf(OrbotoApiError);
  });
});
