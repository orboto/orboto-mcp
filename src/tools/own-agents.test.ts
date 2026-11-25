/** ORB-3258 - `orboto_own_agents`: list, create with the sign-in steps, deactivate under destructiveHint; no reactivate or rename. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { OrbotoClient } from '../orboto-client.js';
import { buildOrbotoMcpServer } from '../server.js';
import { makeOwnAgentsHandler, profileNameFor } from './own-agents.js';

beforeEach(() => { vi.restoreAllMocks(); });
afterEach(() => { vi.restoreAllMocks(); });

function stub(responses: unknown[]) {
  const calls: Array<{ url: string; method: string; body?: unknown }> = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    calls.push({ url: url.toString(), method: init?.method ?? 'GET', body: init?.body ? JSON.parse(init.body as string) : undefined });
    const json = responses.shift();
    return { ok: true, status: 200, statusText: 'OK', json: async () => json, text: async () => JSON.stringify(json) } as unknown as Response;
  });
  return calls;
}

const client = new OrbotoClient({ baseUrl: 'https://orboto.example.com', apiKey: 'orb_x' });
const agentId = '33333333-3333-4333-8333-333333333333';
const agent = { id: agentId, fullName: 'Design Assistant', email: 'design-assistant-1a2b3c4d@agents.internal', createdAt: '2026-11-25T10:00:00.000Z', isActive: true, manageable: true };
const text = (out: { content: unknown[] }) => (out.content[0] as { text: string }).text;

async function listed(toolset?: 'full') {
  const server = await buildOrbotoMcpServer({ baseUrl: 'https://orboto.example.com', apiKey: 'orb_x', ...(toolset ? { toolset } : {}) });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const mcp = new Client({ name: 'own-agents-test', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), mcp.connect(clientTransport)]);
  const { tools } = await mcp.listTools();
  await mcp.close();
  await server.close();
  return tools;
}

describe('ORB-3258 - orboto_own_agents', () => {
  it('lists a page of every own account with its state by default and names the cursor of the next page', async () => {
    const calls = stub([{ items: [agent, { ...agent, id: 'x', isActive: false, manageable: false }], nextCursor: 'next 1' }, { items: [agent], nextCursor: null }]);
    const out = await makeOwnAgentsHandler(client)({});
    expect(calls[0]).toMatchObject({ method: 'GET', url: 'https://orboto.example.com/users/me/owned-bots?include=inactive' });
    expect(text(out)).toContain(`${agentId} Design Assistant <${agent.email}>: active`);
    expect(text(out)).toContain('deactivated, assigned by an administrator');
    expect(text(out)).toContain('More accounts: call again with cursor "next 1".');
    expect(out.structuredContent).toMatchObject({ nextCursor: 'next 1' });
    const last = await makeOwnAgentsHandler(client)({ cursor: 'next 1' });
    expect(calls[1]).toMatchObject({ method: 'GET', url: 'https://orboto.example.com/users/me/owned-bots?include=inactive&cursor=next%201' });
    expect(text(last)).not.toContain('More accounts');
  });

  it('creates and names the sign-in commands with a valid profile name', async () => {
    const calls = stub([agent]);
    const out = await makeOwnAgentsHandler(client)({ action: 'create', name: 'Design Assistant' });
    expect(calls[0]).toMatchObject({ method: 'POST', url: 'https://orboto.example.com/users/me/agents', body: { fullName: 'Design Assistant' } });
    expect(text(out)).toContain('`orboto login --profile design-assistant`, choose "Design Assistant" under "Act as", then `orboto profile bind claude design-assistant`');
    for (const name of ['Design Assistant', '007 Bond', '---', 'Ünïcode Bot', 'x'.repeat(80)]) expect(profileNameFor(name)).toMatch(/^[a-z][a-z0-9_-]{0,47}$/);
    await expect(makeOwnAgentsHandler(client)({ action: 'create' })).rejects.toThrow('create needs name');
  });

  it('deactivates and says what was revoked', async () => {
    const revoked = { apiKeys: 2, oauthTokens: 3, authorizationCodes: 1, workSessions: 1, browserPairings: 0, browserGrants: 1, liveLeases: 0, liveGrants: 0, credentialGrants: 0, capacityClaims: 1 };
    const calls = stub([{ ...agent, isActive: false, revoked, failedCleanups: ['registered_browsers'] }]);
    const out = await makeOwnAgentsHandler(client)({ action: 'deactivate', id: agentId });
    expect(text(out)).toContain('These cleanups failed and were logged: registered_browsers; deactivate it again to retry them.');
    expect(calls[0]).toMatchObject({ method: 'POST', url: `https://orboto.example.com/users/me/agents/${agentId}/deactivate` });
    expect(text(out)).toContain('2 API keys deleted, 3 OAuth tokens and 1 codes revoked');
    await expect(makeOwnAgentsHandler(client)({ action: 'deactivate' })).rejects.toThrow('deactivate needs id');
  });

  it('is in the full toolset only, destructive, says the keys and tokens are revoked for good, and offers no reactivate or rename', async () => {
    const full = await listed('full');
    const tool = full.find((t) => t.name === 'orboto_own_agents');
    expect(tool?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    expect(tool?.description).toContain('its API keys are deleted and its OAuth tokens revoked for good');
    expect((tool?.inputSchema.properties as { action: { enum: string[] } }).action.enum).toEqual(['list', 'create', 'deactivate']);
    expect(full.map((t) => t.name).filter((name) => name.includes('own_agent') && /reactivate|rename/.test(name))).toEqual([]);
    expect((await listed()).map((t) => t.name).filter((name) => name.includes('own_agent'))).toEqual([]);
  });
});
