/** ORB-2767 - receipts leave every JSON body and come back once, as the last text block of the tool result. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OrbotoClient } from './orboto-client.js';
import { collectingReceipts, takeReceipts, withReceiptLines } from './knowledge-receipts.js';
import { withMetrics } from './with-metrics.js';
import { knowledgeUndoToolConfig, makeKnowledgeUndoHandler } from './tools/knowledge.js';
import { makeUpdateDocHandler } from './tools/docs.js';

afterEach(() => { vi.restoreAllMocks(); });

const LINE = 'ACME-D12 "Release window" r41 -> r42 - undo: orboto knowledge undo rcp_7f3a9k2m';
const receipt = { code: 'rcp_7f3a9k2m', line: LINE };

function fetchAnswering(answer: (url: string, init?: RequestInit) => { status: number; body: unknown }) {
  const calls: Array<{ url: string; method: string; body: unknown }> = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    const u = url.toString();
    calls.push({ url: u, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(init.body as string) : undefined });
    const { status, body } = u.includes('/admin/mcp/instrument') ? { status: 201, body: {} } : answer(u, init);
    return {
      ok: status < 400, status, statusText: String(status),
      json: async () => body, text: async () => JSON.stringify(body),
      headers: new Headers({ 'content-type': 'application/json' }),
    } as unknown as Response;
  });
  return calls;
}

describe('ORB-2767 receipt collector', () => {
  it('takes the receipts out of a body and keeps each line once for the running call', async () => {
    const { value, lines } = await collectingReceipts(async () => {
      const a = takeReceipts({ id: 'd1', receipts: [receipt] });
      const b = takeReceipts({ id: 'd2', receipts: [receipt, { code: 'rcp_aaaaaaaa', line: 'second' }] });
      return [a, b];
    });
    expect(value).toEqual([{ id: 'd1' }, { id: 'd2' }]);
    expect(lines).toEqual([LINE, 'second']);
  });

  it('strips receipts outside a tool call without collecting them, and leaves other bodies alone', () => {
    expect(takeReceipts({ id: 'd1', receipts: [receipt] })).toEqual({ id: 'd1' });
    expect(takeReceipts([{ receipts: [receipt] }])).toEqual([{ receipts: [receipt] }]);
    expect(takeReceipts({ receipts: 'not-a-list' })).toEqual({ receipts: 'not-a-list' });
    expect(takeReceipts(undefined)).toBeUndefined();
  });

  it('appends the lines as the last text block, and never to an error result', () => {
    const ok = withReceiptLines({ content: [{ type: 'text', text: 'Updated.' }] }, [LINE]);
    expect(ok.content).toEqual([{ type: 'text', text: 'Updated.' }, { type: 'text', text: LINE }]);
    const failed = withReceiptLines({ content: [{ type: 'text', text: 'no' }], isError: true }, [LINE]);
    expect(failed.content).toHaveLength(1);
    expect(withReceiptLines({ content: [] }, []).content).toEqual([]);
  });

  it('a doc write through withMetrics ends with the receipt line and its structured content carries no receipts', async () => {
    fetchAnswering(() => ({ status: 200, body: { id: 'd1', title: 'Release window', content: 'x', receipts: [receipt] } }));
    const client = new OrbotoClient({ baseUrl: 'https://orboto.example.com', apiKey: 'orb_x' });
    const wrapped = withMetrics(client, 'orboto_update_doc', undefined, makeUpdateDocHandler(client) as never);
    const result = await wrapped({ docId: 'ACME-D12', content: 'more' } as never);
    const texts = result.content.map((c) => (c as { text: string }).text);
    expect(texts[texts.length - 1]).toBe(LINE);
    expect(texts.filter((t) => t.includes('rcp_7f3a9k2m'))).toHaveLength(1);
    expect(JSON.stringify(result.structuredContent ?? {})).not.toContain('receipts');
  });
});

describe('ORB-2767 orboto_knowledge_undo', () => {
  it('posts the receipt code and answers with the server sentence', async () => {
    const calls = fetchAnswering(() => ({ status: 200, body: { receipt: { code: 'rcp_7f3a9k2m' }, undone: ['rcp_7f3a9k2m'], text: 'Undone rcp_7f3a9k2m: ACME-D12 "Release window" r42 -> r41.' } }));
    const client = new OrbotoClient({ baseUrl: 'https://orboto.example.com', apiKey: 'orb_x' });
    const result = await makeKnowledgeUndoHandler(client)({ receipt: ' rcp_7f3a9k2m ' }, { sessionId: 'abc' });
    const call = calls.find((c) => c.url.includes('/knowledge/undo/'))!;
    expect(call.url).toBe('https://orboto.example.com/knowledge/undo/rcp_7f3a9k2m');
    expect(call.method).toBe('POST');
    expect(call.body).toEqual({});
    expect((result.content[0] as { text: string }).text).toContain('Undone rcp_7f3a9k2m');
    expect(result.structuredContent).toEqual({ undone: ['rcp_7f3a9k2m'] });
  });

  it('a page changed since comes back as an agent-visible 409 naming the newer revision and its author', async () => {
    fetchAnswering(() => ({ status: 409, body: { error: 'ACME-D12 changed since: r43 by Dana at 2026-11-03 10:00 UTC. Restore the earlier text with orboto doc restore ACME-D12 <revisionId>.', errorKey: 'errors.knowledge.undo_newer_revision' } }));
    const client = new OrbotoClient({ baseUrl: 'https://orboto.example.com', apiKey: 'orb_x' });
    const wrapped = withMetrics(client, 'orboto_knowledge_undo', undefined, makeKnowledgeUndoHandler(client) as never);
    const result = await wrapped({ receipt: 'rcp_7f3a9k2m' } as never);
    expect(result.isError).toBe(true);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain('409');
    expect(text).toContain('r43 by Dana');
  });

  it('carries a title and is a non-destructive write', () => {
    expect(knowledgeUndoToolConfig.title).toBeTruthy();
    expect(knowledgeUndoToolConfig.annotations).toEqual({ readOnlyHint: false, destructiveHint: false, idempotentHint: true });
  });
});
