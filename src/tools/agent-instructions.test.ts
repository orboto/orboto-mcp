/**
 * ORB-1089 - agent-instruction management MCP tools. Assert the
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
  it('ORB-1700: list returns metadata + excerpt, never full bodies or the assembled text', async () => {
    const calls = stubJSON([{ json: { blocks: [BLOCK], assembled: 'do the thing' } }]);
    const res = await makeListAgentInstructionsHandler(client)();
    expect(calls[0].method).toBe('GET');
    expect(calls[0].url).toContain('/agent-instructions/blocks?scope=workspace');
    const sc = res.structuredContent as { blocks: Record<string, unknown>[]; assembled?: string };
    expect(sc.assembled).toBeUndefined();
    expect(sc.blocks[0].body).toBeUndefined();
    expect(sc.blocks[0].contentChars).toBe(BLOCK.body.length);
    expect(Object.keys(sc.blocks[0]).sort()).toEqual(['contentChars', 'enabled', 'id', 'title']);
  });

  it('ORB-1700: blockId returns the one block with its full body in one call', async () => {
    stubJSON([{ json: { blocks: [BLOCK], assembled: 'x' } }]);
    const res = await makeListAgentInstructionsHandler(client)({ blockId: BLOCK.id });
    const sc = res.structuredContent as { block: { body: string } };
    expect(sc.block.body).toBe(BLOCK.body);
  });

  it('create at project scope carries scope + projectId', async () => {
    const calls = stubJSON([{ status: 201, json: BLOCK }]);
    await makeCreateAgentInstructionHandler(client)({ title: 'P', body: 'b', scope: 'project', projectId: '22222222-2222-2222-2222-222222222222' });
    expect(calls[0].url).toContain('scope=project');
    expect(calls[0].url).toContain('projectId=22222222-2222-2222-2222-222222222222');
  });

  it('create POSTs title + body', async () => {
    const calls = stubJSON([{ status: 201, json: BLOCK }]);
    await makeCreateAgentInstructionHandler(client)({ title: 'Rule', body: 'do the thing' });
    expect(calls[0].method).toBe('POST');
    expect(calls[0].url).toContain('/agent-instructions/blocks?scope=workspace');
    expect(calls[0].body).toEqual({ title: 'Rule', body: 'do the thing' });
  });

  it('update PATCHes by id without the id in the body', async () => {
    const calls = stubJSON([{ json: { ...BLOCK, enabled: false } }]);
    await makeUpdateAgentInstructionHandler(client)({ id: BLOCK.id, enabled: false });
    expect(calls[0]).toMatchObject({ method: 'PATCH', url: `https://orboto.example.com/agent-instructions/blocks/${BLOCK.id}`, body: { enabled: false } });
    expect(calls[0].body).not.toHaveProperty('id');
  });

  it('reset POSTs to the reset sub-path', async () => {
    const calls = stubJSON([{ json: BLOCK }]);
    await makeResetAgentInstructionHandler(client)({ id: BLOCK.id });
    expect(calls[0]).toMatchObject({ method: 'POST', url: `https://orboto.example.com/agent-instructions/blocks/${BLOCK.id}/reset` });
  });

  it('delete DELETEs by id', async () => {
    const calls = stubJSON([{ json: {} }]);
    const res = await makeDeleteAgentInstructionHandler(client)({ id: BLOCK.id });
    expect(calls[0]).toMatchObject({ method: 'DELETE', url: `https://orboto.example.com/agent-instructions/blocks/${BLOCK.id}` });
    expect(res.structuredContent).toMatchObject({ deleted: true });
  });

  // ORB-1819 - the writing-for-tokens size contract, passed through from
  // the REST route's warn (200 + sizeWarning) / block (422) responses.
  describe('ORB-1819 size contract', () => {
    it('create surfaces a soft-limit sizeWarning in the success text, not as an error', async () => {
      const oversizeBlock = { ...BLOCK, body: 'x'.repeat(450), sizeWarning: { chars: 450, limit: 400, hint: 'move it to a doc' } };
      stubJSON([{ status: 201, json: oversizeBlock }]);
      const res = await makeCreateAgentInstructionHandler(client)({ title: 'Long', body: 'x'.repeat(450) });
      expect(res.isError).toBeUndefined();
      const text = (res.content[0] as { text: string }).text;
      expect(text).toContain('450 chars');
      expect(text).toContain('move it to a doc');
    });

    it('create turns a hard-cap 422 into a non-throwing blocked result carrying the override recipe', async () => {
      const blockBody = JSON.stringify({
        error: 'This rule content is 850 characters, over the 800-character hard limit.',
        errorKey: 'errors.agent_content.oversize',
        sizeWarning: { chars: 850, limit: 800, hint: 'move it to a doc and keep the doc key here' },
      });
      vi.spyOn(globalThis, 'fetch').mockImplementation(async () => (
        { ok: false, status: 422, statusText: 'Unprocessable', json: async () => ({}), text: async () => blockBody } as unknown as Response
      ));
      const res = await makeCreateAgentInstructionHandler(client)({ title: 'Way too long', body: 'x'.repeat(850) });
      expect(res.isError).toBe(true);
      const text = (res.content[0] as { text: string }).text;
      expect(text).toContain('850');
      expect(text).toContain('allowOversize=true');
      expect(text).toContain('oversizeReason');
      const sc = res.structuredContent as { blocked: boolean; sizeWarning: { limit: number } };
      expect(sc.blocked).toBe(true);
      expect(sc.sizeWarning.limit).toBe(800);
    });

    it('create passes allowOversize + oversizeReason through to the POST body', async () => {
      const calls = stubJSON([{ status: 201, json: { ...BLOCK, sizeWarning: { chars: 850, limit: 800, hint: 'h' } } }]);
      await makeCreateAgentInstructionHandler(client)({
        title: 'Long', body: 'x'.repeat(850), allowOversize: true, oversizeReason: 'genuinely needs the full list',
      });
      expect(calls[0].body).toMatchObject({ allowOversize: true, oversizeReason: 'genuinely needs the full list' });
    });

    it('update turns a hard-cap 422 into a non-throwing blocked result', async () => {
      const blockBody = JSON.stringify({
        error: 'oversize', errorKey: 'errors.agent_content.oversize',
        sizeWarning: { chars: 900, limit: 800, hint: 'shorten it' },
      });
      vi.spyOn(globalThis, 'fetch').mockImplementation(async () => (
        { ok: false, status: 422, statusText: 'Unprocessable', json: async () => ({}), text: async () => blockBody } as unknown as Response
      ));
      const res = await makeUpdateAgentInstructionHandler(client)({ id: BLOCK.id, body: 'x'.repeat(900) });
      expect(res.isError).toBe(true);
      const sc = res.structuredContent as { blocked: boolean };
      expect(sc.blocked).toBe(true);
    });
  });
});
