/** ORB-3078 - `orboto_credential_agent_access` handler tests and its listed annotations and title. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { OrbotoClient } from '../orboto-client.js';
import { buildOrbotoMcpServer } from '../server.js';
import { credentialAgentAccessToolConfig, makeCredentialAgentAccessHandler } from './credential-agent-access.js';

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
const credentialId = '11111111-1111-4111-8111-111111111111';
const agentId = '22222222-2222-4222-8222-222222222222';
const keyId = '33333333-3333-4333-8333-333333333333';
const entryId = '44444444-4444-4444-8444-444444444444';
const entry = {
  id: entryId, credentialId, agentUserId: agentId, agentName: 'Deploy bot', agentEmail: 'deploy-bot@example.org', agentIsBot: true,
  apiKeyId: keyId, apiKeyName: 'deploy', apiKeyPrefix: 'orb_1a2b', oauthClientId: null, oauthClientName: null,
  purposes: ['totp'], source: 'manual', grantedBy: null, grantedAt: '2026-11-13T10:00:00.000Z',
};
const text = (out: { content: unknown[] }) => (out.content[0] as { text: string }).text;

describe('orboto_credential_agent_access', () => {
  it('resolves a key to its id and lists the entries, or says that no agent may reveal', async () => {
    const calls = stub([{ json: { items: [{ id: credentialId, key: 'build-login' }] } }, { json: [entry] }, { json: [] }]);
    const handler = makeCredentialAgentAccessHandler(client);
    const out = await handler({ credential: 'build-login' });
    expect(calls[0].url).toContain('/credentials?key=build-login&limit=10');
    expect(calls[1]).toMatchObject({ method: 'GET', url: expect.stringContaining(`/credentials/${credentialId}/agent-access`) });
    expect(text(out)).toBe(`${entryId} Deploy bot (bot): key "deploy" (orb_1a2b), totp`);
    const empty = await handler({ action: 'list', credential: credentialId });
    expect(text(empty)).toContain('No agent may reveal this credential');
  });

  it('lists the candidates that can reveal the credential, searched by q, and keeps the page bound by the server', async () => {
    const candidate = {
      userId: agentId, name: 'Deploy bot', email: 'deploy-bot@example.org', isBot: true,
      agentKeys: [{ id: keyId, name: 'deploy', keyPrefix: 'orb_1a2b' }], oauthClients: [{ clientId: 'mcp-client-7f3a', clientName: 'Claude Desktop' }],
    };
    const calls = stub([{ json: [candidate] }, { json: [] }, { json: [candidate] }]);
    const handler = makeCredentialAgentAccessHandler(client);
    const out = await handler({ action: 'candidates', credential: credentialId, q: ' deploy ' });
    expect(calls[0]).toMatchObject({ method: 'GET', url: expect.stringContaining(`/credentials/${credentialId}/agent-access/candidates?q=deploy`) });
    expect(text(out)).toBe(`${agentId} Deploy bot <deploy-bot@example.org> (bot)\n  key ${keyId} "deploy" (orb_1a2b)\n  OAuth client mcp-client-7f3a "Claude Desktop"`);
    expect(text(await handler({ action: 'candidates', credential: credentialId, q: 'nobody' }))).toContain('No bot account or agent key that can reveal this credential matches');
    await handler({ action: 'candidates', credential: credentialId });
    expect(calls[2].url).toMatch(/agent-access\/candidates$/);
  });

  it('writes nothing: the input has no add, purposes or remove action and no write request leaves', async () => {
    const calls = stub([]);
    expect(Object.keys(credentialAgentAccessToolConfig.inputSchema).sort()).toEqual(['action', 'credential', 'q']);
    expect(credentialAgentAccessToolConfig.inputSchema.action.safeParse('add').success).toBe(false);
    expect(credentialAgentAccessToolConfig.inputSchema.action.safeParse('remove').success).toBe(false);
    expect(credentialAgentAccessToolConfig.inputSchema.action.safeParse('purposes').success).toBe(false);
    expect(calls).toEqual([]);
  });

  it('explains a 404 as a missing manage right', async () => {
    stub([{ ok: false, status: 404, json: { error: 'not found', errorKey: 'errors.credential.not_found' } }]);
    await expect(makeCredentialAgentAccessHandler(client)({ credential: credentialId })).rejects.toThrow(/needs manage on the credential/);
  });

  it('is listed in the full manifest only, with its title and a read-only annotation', async () => {
    const listed = async (toolset?: 'full') => {
      const server = await buildOrbotoMcpServer({ baseUrl: 'https://orboto.example.com', apiKey: 'orb_x', ...(toolset ? { toolset } : {}) });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      const mcp = new Client({ name: 't', version: '0' });
      await Promise.all([server.connect(serverTransport), mcp.connect(clientTransport)]);
      const { tools } = await mcp.listTools();
      await mcp.close();
      return tools.find((t) => t.name === 'orboto_credential_agent_access');
    };
    expect(await listed()).toBeUndefined();
    const tool = await listed('full');
    expect(tool?.title).toBe('Credential agent access');
    expect(tool?.annotations).toMatchObject({ readOnlyHint: true, idempotentHint: true });
    expect(tool?.annotations?.destructiveHint).not.toBe(true);
  });
});
