/** ORB-2837 - `orboto_browser_grants` handler tests and the listed annotations without the default hints. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { OrbotoClient } from '../orboto-client.js';
import { buildOrbotoMcpServer, withoutDefaultHints } from '../server.js';
import { browserGrantsToolConfig, makeBrowserGrantsHandler } from './browser-grants.js';

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
const pairingId = '11111111-1111-4111-8111-111111111111';
const grantId = '22222222-2222-4222-8222-222222222222';
const grant = {
  id: grantId, pairingId, browserName: 'Chrome', grantorEmail: 'daniel@example.org', granteeEmail: 'claude@example.org', lifetime: '7d',
  expiresAt: '2026-11-12T10:00:00.000Z', sessionName: null, ticketKey: null, lastUsedAt: null, useCount: 0, endReason: null, active: true, canRevoke: true,
};
const text = (out: { content: unknown[] }) => (out.content[0] as { text: string }).text;

describe('orboto_browser_grants', () => {
  it('lists the caller\'s grants by default and every grant with all', async () => {
    const calls = stub([{ json: { items: [grant], nextCursor: null } }, { json: { items: [], nextCursor: null } }]);
    const handler = makeBrowserGrantsHandler(client);
    const mine = await handler({});
    expect(calls[0]).toMatchObject({ method: 'GET', url: expect.stringContaining('/agents/browser-grants?scope=mine') });
    expect(text(mine)).toContain(`${grantId} Chrome of daniel@example.org -> claude@example.org: 7d, until 2026-11-12T10:00:00.000Z`);
    const all = await handler({ action: 'list', all: true });
    expect(calls[1].url).toContain('scope=all');
    expect(text(all)).toContain('No browser grants.');
  });

  it('grants with the pairing, the account and the lifetime and warns for a lifetime past the session', async () => {
    const calls = stub([{ json: grant }, { json: { ...grant, lifetime: 'session', expiresAt: null } }]);
    const handler = makeBrowserGrantsHandler(client);
    const out = await handler({ action: 'grant', id: pairingId, grantee: 'claude@example.org', lifetime: '7d' });
    expect(calls[0]).toMatchObject({ method: 'POST', body: { pairingId, grantee: 'claude@example.org', lifetime: '7d' } });
    expect(text(out)).toContain('without anyone watching');
    const session = await handler({ action: 'grant', id: pairingId, grantee: 'claude@example.org', lifetime: 'session' });
    expect(text(session)).not.toContain('without anyone watching');
  });

  it('says a grant for a ticket that is already closed is refused, not that the grant was to yourself', async () => {
    const calls = stub([{ ok: false, status: 422, json: { error: 'closed', errorKey: 'errors.agents.browser_grant_ticket_closed' } }]);
    const handler = makeBrowserGrantsHandler(client);
    await expect(handler({ action: 'grant', id: pairingId, grantee: 'claude@example.org', lifetime: 'ticket', ticketKey: 'ORB-12' }))
      .rejects.toThrow(/already closed.*Pick an open ticket or another lifetime/);
    expect(calls).toHaveLength(1);
    expect(browserGrantsToolConfig.description).toContain('A grant to yourself or for a closed ticket is refused (422)');
  });

  it('refuses an incomplete grant or revoke before any request', async () => {
    const calls = stub([]);
    const handler = makeBrowserGrantsHandler(client);
    await expect(handler({ action: 'grant', id: pairingId, lifetime: '1d' })).rejects.toThrow(/grantee/);
    await expect(handler({ action: 'grant', id: pairingId, grantee: 'claude@example.org', lifetime: 'ticket' })).rejects.toThrow(/ticketKey/);
    await expect(handler({ action: 'revoke' })).rejects.toThrow(/id/);
    expect(calls).toEqual([]);
  });

  it('revokes by grant id and explains a 404 with the owner rule', async () => {
    const calls = stub([{ json: { ...grant, active: false, endReason: 'revoked' } }, { ok: false, status: 404, json: { error: 'not found', errorKey: 'errors.agents.browser_grant_not_found' } }]);
    const handler = makeBrowserGrantsHandler(client);
    const out = await handler({ action: 'revoke', id: grantId });
    expect(calls[0]).toMatchObject({ method: 'DELETE', url: expect.stringContaining(`/agents/browser-grants/${grantId}`) });
    expect(text(out)).toContain('ended (revoked)');
    await expect(handler({ action: 'revoke', id: grantId })).rejects.toThrow(/Only the browser's owner grants it/);
  });

  it('says a grant to yourself is refused and changes nothing, and that a revoke ends the grant now', async () => {
    const calls = stub([
      { ok: false, status: 422, json: { error: 'self', errorKey: 'errors.agents.browser_grant_self' } },
      { json: { ...grant, active: false, endReason: 'revoked' } },
    ]);
    const handler = makeBrowserGrantsHandler(client);
    await expect(handler({ action: 'grant', id: pairingId, grantee: 'daniel@example.org', lifetime: 'forever' }))
      .rejects.toThrow(/A grant to yourself changes nothing: your own sessions approve themselves through the login pairing/);
    const revoked = await handler({ action: 'revoke', id: grantId });
    expect(text(revoked)).toContain('a browser connected to orboto closes the connections it opened at once, one that is not closes them when it connects again');
    expect(calls).toHaveLength(2);
    expect(browserGrantsToolConfig.description).toContain('A grant to yourself or for a closed ticket is refused (422)');
    expect(browserGrantsToolConfig.description).toContain('lapses after 8h without a start');
  });

  it('lists a session or ticket grant no start has bound as waiting with its lapse time', async () => {
    stub([{ json: { items: [
      { ...grant, lifetime: 'session', expiresAt: '2026-11-05T18:00:00.000Z' },
      { ...grant, lifetime: 'ticket', ticketKey: 'ORB-12', expiresAt: '2026-11-05T18:00:00.000Z' },
      { ...grant, lifetime: 'ticket', ticketKey: 'ORB-13', expiresAt: null },
    ], nextCursor: null } }]);
    const listed = text(await makeBrowserGrantsHandler(client)({}));
    expect(listed).toContain('session, until the session that starts it first ends (lapses 2026-11-05T18:00:00.000Z unused)');
    expect(listed).toContain('ticket, until the work on ORB-12 ends (lapses 2026-11-05T18:00:00.000Z unused)');
    expect(listed).toContain('ticket, until the work on ORB-13 ends,');
  });

  it('is a destructive write with a title', () => {
    expect(browserGrantsToolConfig.title).toBe('Browser grants');
    expect(browserGrantsToolConfig.annotations).toEqual({ readOnlyHint: false, destructiveHint: true, idempotentHint: false });
  });
});

describe('ORB-2837 - listed annotations leave out the MCP default idempotentHint false', () => {
  it('drops only idempotentHint false and keeps every other hint', () => {
    expect(withoutDefaultHints({ title: 't', annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false } }))
      .toEqual({ title: 't', annotations: { readOnlyHint: false, destructiveHint: true } });
    const kept = { annotations: { readOnlyHint: true, idempotentHint: true } };
    expect(withoutDefaultHints(kept)).toBe(kept);
    expect(withoutDefaultHints({ title: 'x' })).toEqual({ title: 'x' });
  });

  it('no listed tool carries idempotentHint false and the grants tool is listed with its hints', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline test'));
    const server = await buildOrbotoMcpServer({ baseUrl: 'https://orboto.example.com', apiKey: 'orb_test', toolset: 'full' });
    const [a, b] = InMemoryTransport.createLinkedPair();
    const mcp = new Client({ name: 'hints', version: '0' });
    await Promise.all([server.connect(b), mcp.connect(a)]);
    const tools = (await mcp.listTools()).tools as Array<{ name: string; annotations?: Record<string, unknown> }>;
    await mcp.close();
    expect(tools.filter((tool) => tool.annotations?.idempotentHint === false).map((tool) => tool.name)).toEqual([]);
    expect(tools.find((tool) => tool.name === 'orboto_browser_grants')?.annotations).toEqual({ readOnlyHint: false, destructiveHint: true });
  });
});
