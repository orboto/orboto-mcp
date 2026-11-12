/** ORB-3048 - `orboto_browser_standing_allows`: list and revoke only, the mirrored enums pinned to the shared schema, listed with its hints. */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { OrbotoClient } from '../orboto-client.js';
import { buildOrbotoMcpServer } from '../server.js';
import { browserStandingToolConfig, makeBrowserStandingHandler, STANDING_DURATIONS, STANDING_ID_PATTERN, STANDING_STEPS } from './browser-standing.js';

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
const sessionId = '11111111-1111-4111-8111-111111111111';
const allow = {
  id: '3f9a01c2d4', host: 'shop.example.org', step: 'click', target: 'button "Pay now"', duration: '1h',
  until: '2026-11-12T10:00:00.000Z', createdAt: '2026-11-12T09:00:00.000Z', revokeRequestedAt: null,
};
const text = (out: { content: unknown[] }) => (out.content[0] as { text: string }).text;

describe('orboto_browser_standing_allows', () => {
  it('lists the standing allows of a session with their end', async () => {
    const calls = stub([{ json: { items: [allow, { ...allow, id: '77ab3c90e1', duration: 'session', until: null }] } }, { json: { items: [] } }]);
    const handler = makeBrowserStandingHandler(client);
    const listed = text(await handler({ sessionId }));
    expect(calls[0]).toMatchObject({ method: 'GET', url: `https://orboto.example.com/agents/browser-sessions/${sessionId}/standing-allows` });
    expect(listed).toContain('3f9a01c2d4 click button "Pay now" on shop.example.org, until 2026-11-12T10:00:00.000Z');
    expect(listed).toContain('77ab3c90e1 click button "Pay now" on shop.example.org, until the session ends');
    expect(text(await handler({ sessionId, action: 'list' }))).toContain('Only the person creates one');
  });

  it('revokes one by id or all, and needs exactly one of them', async () => {
    const calls = stub([{ json: { items: [{ ...allow, revokeRequestedAt: '2026-11-12T09:30:00.000Z' }] } }, { json: { items: [] } }]);
    const handler = makeBrowserStandingHandler(client);
    const one = text(await handler({ sessionId, action: 'revoke', allowId: '3f9a01c2d4' }));
    expect(calls[0]).toMatchObject({ method: 'DELETE', url: `https://orboto.example.com/agents/browser-sessions/${sessionId}/standing-allows/3f9a01c2d4` });
    expect(one).toContain('revoke requested 2026-11-12T09:30:00.000Z');
    await handler({ sessionId, action: 'revoke', all: true });
    expect(calls[1]).toMatchObject({ method: 'DELETE', url: `https://orboto.example.com/agents/browser-sessions/${sessionId}/standing-allows` });
    await expect(handler({ sessionId, action: 'revoke' })).rejects.toThrow('revoke needs allowId');
    await expect(handler({ sessionId, action: 'revoke', allowId: '3f9a01c2d4', all: true })).rejects.toThrow('not both');
    expect(calls).toHaveLength(2);
  });

  it('names an unknown standing allow and a foreign session', async () => {
    stub([
      { ok: false, status: 404, json: { errorKey: 'errors.agents.browser_standing_not_found' } },
      { ok: false, status: 404, json: { errorKey: 'errors.agents.browser_session_not_found' } },
    ]);
    const handler = makeBrowserStandingHandler(client);
    await expect(handler({ sessionId, action: 'revoke', allowId: '0000000000' })).rejects.toThrow('ended, ran out or was revoked');
    await expect(handler({ sessionId })).rejects.toThrow('another account');
  });

  it('offers no way to create or extend a standing allow', () => {
    expect(Object.keys(browserStandingToolConfig.inputSchema).sort()).toEqual(['action', 'all', 'allowId', 'sessionId']);
    expect(browserStandingToolConfig.inputSchema.action.unwrap().options).toEqual(['list', 'revoke']);
    expect(browserStandingToolConfig.title).toBe('Browser standing allows');
    expect(browserStandingToolConfig.annotations).toEqual({ readOnlyHint: false, destructiveHint: true, idempotentHint: true });
  });

  it('keeps the mirrored id, step and duration in sync with the shared schema', () => {
    const canonical = readFileSync(path.resolve(process.cwd(), '../../packages/shared-schema/src/agent-browser-sessions.ts'), 'utf8');
    const enumOf = (name: string) => canonical.match(new RegExp(`${name} = z\\.enum\\(\\[([^\\]]+)\\]`))?.[1].match(/'([^']+)'/g)?.map((value) => value.slice(1, -1));
    expect(enumOf('BrowserStandingStepSchema')).toEqual([...STANDING_STEPS]);
    expect(enumOf('BrowserStandingDurationSchema')).toEqual([...STANDING_DURATIONS]);
    expect(canonical).toContain(`BrowserStandingIdSchema = z.string().regex(${STANDING_ID_PATTERN.toString()},`);
  });

  it('is listed in the full manifest with its hints', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline test'));
    const server = await buildOrbotoMcpServer({ baseUrl: 'https://orboto.example.com', apiKey: 'orb_test', toolset: 'full' });
    const [a, b] = InMemoryTransport.createLinkedPair();
    const mcp = new Client({ name: 'standing', version: '0' });
    await Promise.all([server.connect(b), mcp.connect(a)]);
    const tools = (await mcp.listTools()).tools as Array<{ name: string; annotations?: Record<string, unknown> }>;
    await mcp.close();
    expect(tools.find((tool) => tool.name === 'orboto_browser_standing_allows')?.annotations).toEqual({ readOnlyHint: false, destructiveHint: true, idempotentHint: true });
  });
});
