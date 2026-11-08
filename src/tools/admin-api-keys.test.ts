/** ORB-2931 - `orboto_admin_api_key_list` and `orboto_admin_api_key_revoke`: list by owner, revoke by id, and no tool takes a key value. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OrbotoClient } from '../orboto-client.js';
import {
  adminApiKeyListToolConfig, adminApiKeyRevokeToolConfig, makeAdminApiKeyListHandler, makeAdminApiKeyRevokeHandler,
} from './admin-api-keys.js';

beforeEach(() => { vi.restoreAllMocks(); });
afterEach(() => { vi.restoreAllMocks(); });

function stub(responses: Array<{ ok?: boolean; status?: number; json?: unknown }>) {
  const calls: Array<{ url: string; method: string; body?: unknown }> = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    calls.push({ url: url.toString(), method: init?.method ?? 'GET', body: init?.body ? JSON.parse(init.body as string) : undefined });
    const r = responses.shift();
    if (!r) throw new Error(`unexpected extra fetch ${init?.method ?? 'GET'} ${url.toString()}`);
    return {
      ok: r.ok ?? true,
      status: r.status ?? 200,
      statusText: r.ok === false ? 'Error' : 'OK',
      json: async () => ('json' in r ? r.json : {}),
      text: async () => JSON.stringify('json' in r ? r.json : {}),
    } as unknown as Response;
  });
  return calls;
}

const client = new OrbotoClient({ baseUrl: 'https://orboto.example.com', apiKey: 'orb_x' });
const keyId = '33333333-3333-4333-8333-333333333333';
const ownerId = '44444444-4444-4444-8444-444444444444';
const row = (email: string, name = 'ci deploy') => ({
  id: keyId, name, keyPrefix: 'orb_1a2b', userId: ownerId, userName: 'Agent A', userEmail: email, requestCount: 12, isAgent: true,
  lastUsedAt: '2026-11-08T10:00:00.000Z', expiresAt: null, createdAt: '2026-10-01T10:00:00.000Z', flags: ['stale'], share: 0.5,
});
const text = (out: { content: unknown[] }) => (out.content[0] as { text: string }).text;

describe('orboto_admin_api_key_list', () => {
  it('narrows the server search to the exact owner email', async () => {
    const calls = stub([{ json: { totalRequests: 24, keys: [row('agent-a@example.org'), row('xagent-a@example.org.evil', 'other')] } }]);
    const out = await makeAdminApiKeyListHandler(client)({ owner: 'Agent-A@example.org' });
    expect(calls[0]).toMatchObject({ method: 'GET', url: expect.stringContaining('/admin/api-keys?sort=requests&search=Agent-A%40example.org') });
    expect(text(out)).toContain(`- ${keyId} "ci deploy" (orb_1a2b) of Agent A <agent-a@example.org>: 12 requests, last used 2026-11-08T10:00:00.000Z, expires never, agent, stale`);
    expect(text(out)).not.toContain('other');
    expect(out.structuredContent).toMatchObject({ count: 1, total: 1 });
  });

  it('says what a 403 needs', async () => {
    stub([{ ok: false, status: 403, json: { error: 'Forbidden' } }]);
    await expect(makeAdminApiKeyListHandler(client)({})).rejects.toThrow('admin:audit:read');
  });
});

describe('orboto_admin_api_key_revoke', () => {
  it('revokes by id with the reason and names the owner', async () => {
    const key = { ...row('agent-a@example.org'), userIsBot: true };
    const calls = stub([{ json: { revoked: true, key } }]);
    const out = await makeAdminApiKeyRevokeHandler(client)({ id: keyId, reason: ' leaked in .mcp.json ' });
    expect(calls[0]).toMatchObject({ method: 'POST', url: `https://orboto.example.com/admin/api-keys/${keyId}/revoke`, body: { reason: 'leaked in .mcp.json' } });
    expect(text(out)).toContain('Revoked "ci deploy" (orb_1a2b) of Agent A <agent-a@example.org>. Requests with it now get 401');
  });

  it('turns 403 and 404 into the permission and a plain not-found', async () => {
    stub([{ ok: false, status: 403, json: {} }, { ok: false, status: 404, json: {} }]);
    const handler = makeAdminApiKeyRevokeHandler(client);
    await expect(handler({ id: keyId })).rejects.toThrow('admin:users:write');
    await expect(handler({ id: keyId })).rejects.toThrow('No API key with that id');
  });

  it('takes no key value as an argument and is annotated as a destructive write', () => {
    for (const config of [adminApiKeyListToolConfig, adminApiKeyRevokeToolConfig]) {
      expect(Object.keys(config.inputSchema)).not.toEqual(expect.arrayContaining(['key']));
      expect(Object.keys(config.inputSchema)).not.toEqual(expect.arrayContaining(['value']));
      expect(config.description).toContain('--key-stdin');
    }
    expect(Object.keys(adminApiKeyRevokeToolConfig.inputSchema).sort()).toEqual(['id', 'reason']);
    expect(adminApiKeyRevokeToolConfig.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    expect(adminApiKeyListToolConfig.annotations).toMatchObject({ readOnlyHint: true });
  });
});
