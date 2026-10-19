/** ORB-2542 - the owner check of orboto_agent_notify and orboto_who for. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OrbotoClient } from '../orboto-client.js';
import { ownerLine, type OwnerMatch } from './responsibilities.js';
import { makeAgentNotifyHandler } from './agent-coordination.js';
import { makeAgentWhoHandler } from './agent-who.js';

afterEach(() => { vi.restoreAllMocks(); });

const client = new OrbotoClient({ baseUrl: 'https://orboto.example.com', apiKey: 'orb_test' });

const match: OwnerMatch = {
  entry: { id: '6f1e2d3c-4b5a-4968-8776-a5b4c3d2e1f0', topic: 'Game development', ownerAddress: 'worker@GAMES', keywords: ['unity'], humanOwner: { email: 'owner@orboto.test', fullName: 'Owner Person' }, deputy: null },
  score: 0.8, reason: 'keyword', matched: ['unity', 'asset'], routes: true,
};

function respond(status: number, body: unknown, urls: string[] = [], bodies: unknown[] = []) {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    urls.push(String(url));
    if (init?.body) bodies.push(JSON.parse(init.body as string));
    return { ok: status < 400, status, statusText: 'x', json: async () => body, text: async () => JSON.stringify(body) } as unknown as Response;
  });
}

describe('ownerLine', () => {
  it('prints owner address, topic, human owner and why it matched, and marks a weak match', () => {
    expect(ownerLine(match)).toBe('- worker@GAMES - Game development, human Owner Person (score 0.8, keyword: unity, asset)');
    expect(ownerLine({ ...match, routes: false, reason: 'embedding', matched: [] })).toContain('embedding, too weak to route');
  });
});

describe('orboto_agent_notify owner check', () => {
  const request = { to: 'integrator@OPS', kind: 'request' as const, subject: 'Unity asset on storage', outcome: 'The asset is stored for the game.' };

  it('sends ownerCheck refuse and turns 409 owner_mismatch into a tool error naming the owner and both ways on', async () => {
    const bodies: unknown[] = [];
    respond(409, { error: 'x', errorKey: 'errors.agents.owner_mismatch', errorParams: { topic: 'Game development', owner: 'worker@GAMES', target: 'integrator@OPS', ownerHint: { text: '"Game development" belongs to worker@GAMES, not integrator@OPS' } } }, [], bodies);
    const result = await makeAgentNotifyHandler(client)(request);
    expect((bodies[0] as { ownerCheck?: string }).ownerCheck).toBe('refuse');
    expect(result.isError).toBe(true);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain('belongs to worker@GAMES');
    expect(text).toContain('route: true');
    expect(text).toContain('forceTarget: true');
  });

  it('passes route on and reports the owner it went to', async () => {
    const bodies: unknown[] = [];
    respond(200, { ok: true, messageId: '6f1e2d3c-4b5a-4968-8776-a5b4c3d2e1f1', toSessionId: null, routedTo: 'session', recipients: [{ label: 'w@orboto.test (worker, aaaaaaaa)', sessionId: null }, { label: 'w2@orboto.test (worker, bbbbbbbb)', sessionId: null }], ownerHint: { ownerAddress: 'worker@GAMES', topic: 'Game development', target: 'integrator@OPS', routed: true, text: '' } }, [], bodies);
    const result = await makeAgentNotifyHandler(client)({ ...request, route: true });
    expect(bodies[0]).toMatchObject({ route: true, ownerCheck: 'refuse' });
    expect((result.content[0] as { text: string }).text).toContain('routed to the owner of "Game development" instead of integrator@OPS');
    expect(result.structuredContent).toMatchObject({ owner: 'worker@GAMES' });
  });
});

describe('orboto_who for', () => {
  it('passes for, names the owner, and points at the queue when nobody answers', async () => {
    const urls: string[] = [];
    respond(200, { sessions: [], owner: match }, urls);
    const result = await makeAgentWhoHandler(client)({ for: 'unity asset' });
    expect(urls[0]).toBe('https://orboto.example.com/v1/agent/who?for=unity+asset&limit=4');
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain('Owner:\n- worker@GAMES');
    expect(text).toContain('No live session answers to worker@GAMES - send with queue: true and project GAMES');
    expect(result.structuredContent).toMatchObject({ owner: expect.objectContaining({ reason: 'keyword' }) });
  });
});
