/**
 * ORB-1089 — agent-instruction management MCP tools. Assert the
 * outgoing wire shape (method + URL + body) against the admin REST
 * surface, catching shape drift at the unit layer.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OrbotoClient } from '../orboto-client.js';
import {
  makeListAgentInstructionsHandler,
  makeCreateAgentInstructionHandler,
  makeUpdateAgentInstructionHandler,
  makeResetAgentInstructionHandler,
  makeDeleteAgentInstructionHandler,
} from './agent-instructions.js';

beforeEach(() => { vi.restoreAllMocks(); });
afterEach(() => { vi.restoreAllMocks(); });

function stubJSON(responses: Array<{ ok?: boolean; status?: number; json?: unknown }>) {
  const calls: Array<{ url: string; method: string; body?: unknown }> = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    calls.push({
      url: url.toString(),
      method: init?.method ?? 'GET',
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body,
    });
    const r = responses.shift();
    if (!r) throw new Error('unexpected extra fetch');
    return { ok: r.ok ?? true, status: r.status ?? 200, statusText: 'OK', json: async () => ('json' in r ? r.json : {}), text: async () => '' } as unknown as Response;
  });
  return calls;
}

const client = new OrbotoClient({ baseUrl: 'https://orboto.example.com', apiKey: 'orb_x' });
const BLOCK = { id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', builtinKey: null, title: 'Rule', body: 'do the thing', enabled: true, sortOrder: 10 };

describe('agent-instruction MCP tools (ORB-1089)', () => {
  it('list GETs the admin surface and returns blocks + assembled', async () => {
    const calls = stubJSON([{ json: { blocks: [BLOCK], assembled: 'do the thing' } }]);
    const res = await makeListAgentInstructionsHandler(client)();
    expect(calls[0]).toMatchObject({ method: 'GET', url: 'https://orboto.example.com/admin/agent-instructions' });
    expect(res.structuredContent).toMatchObject({ assembled: 'do the thing' });
  });

  it('create POSTs title + body', async () => {
    const calls = stubJSON([{ status: 201, json: BLOCK }]);
    await makeCreateAgentInstructionHandler(client)({ title: 'Rule', body: 'do the thing' });
    expect(calls[0]).toMatchObject({ method: 'POST', url: 'https://orboto.example.com/admin/agent-instructions', body: { title: 'Rule', body: 'do the thing' } });
  });

  it('update PATCHes by id without the id in the body', async () => {
    const calls = stubJSON([{ json: { ...BLOCK, enabled: false } }]);
    await makeUpdateAgentInstructionHandler(client)({ id: BLOCK.id, enabled: false });
    expect(calls[0]).toMatchObject({ method: 'PATCH', url: `https://orboto.example.com/admin/agent-instructions/${BLOCK.id}`, body: { enabled: false } });
    expect(calls[0].body).not.toHaveProperty('id');
  });

  it('reset POSTs to the reset sub-path', async () => {
    const calls = stubJSON([{ json: BLOCK }]);
    await makeResetAgentInstructionHandler(client)({ id: BLOCK.id });
    expect(calls[0]).toMatchObject({ method: 'POST', url: `https://orboto.example.com/admin/agent-instructions/${BLOCK.id}/reset` });
  });

  it('delete DELETEs by id', async () => {
    const calls = stubJSON([{ json: {} }]);
    const res = await makeDeleteAgentInstructionHandler(client)({ id: BLOCK.id });
    expect(calls[0]).toMatchObject({ method: 'DELETE', url: `https://orboto.example.com/admin/agent-instructions/${BLOCK.id}` });
    expect(res.structuredContent).toMatchObject({ deleted: true });
  });
});
