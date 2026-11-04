/** ORB-2758 - `orboto_upload_link` mints a browser upload link for a ticket or doc and tells the model to hand it to the person. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { OrbotoClient } from '../orboto-client.js';
import { buildOrbotoMcpServer } from '../server.js';
import type { Toolset } from '../toolset.js';
import { makeUploadLinkHandler } from './upload-link.js';

beforeEach(() => { vi.restoreAllMocks(); });
afterEach(() => { vi.restoreAllMocks(); });

const client = new OrbotoClient({ baseUrl: 'https://orboto.example.com', apiKey: 'orb_x' });
const PROJ = { id: 'p1', key: 'PRE', name: 'Pre', description: null, status: 'active' };
const TICKET = { id: 't1', projectId: 'p1', ticketKey: 'PRE-289', ticketNumber: 289, title: 'Plans' };
const DOC_ID = '9f1c1b0e-6c1b-4b7e-9a7c-1d2e3f4a5b6c';

function link(targetType: 'ticket' | 'doc', targetId: string, targetKey: string) {
  return { id: 'l1', url: 'https://tasks.orboto.test/upload/tok', expiresAt: '2026-11-04T12:15:00.000Z', targetType, targetId, targetKey, maxBytes: 52428800 };
}

function mockFetch(answers: unknown[]) {
  const calls: Array<{ url: string; method: string; body: unknown }> = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    calls.push({ url: url.toString(), method: init?.method ?? 'GET', body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined });
    const json = answers.shift();
    return { ok: true, status: 200, statusText: 'OK', json: async () => json, text: async () => JSON.stringify(json) } as unknown as Response;
  });
  return calls;
}

describe('orboto_upload_link', () => {
  it('mints for a ticket key and tells the model to hand the URL to the person', async () => {
    const calls = mockFetch([PROJ, TICKET, link('ticket', 't1', 'PRE-289')]);
    const res = await makeUploadLinkHandler(client)({ ticketKey: 'PRE-289' });
    const mint = calls.at(-1)!;
    expect(mint).toMatchObject({ url: 'https://orboto.example.com/tickets/t1/attachments/upload-links', method: 'POST', body: {} });
    const text = (res.content[0] as { text: string }).text;
    expect(text).toContain('https://tasks.orboto.test/upload/tok');
    expect(text).toContain('2026-11-04T12:15:00.000Z');
    expect(text).toContain('Give this URL to the person');
    expect(res.structuredContent).toEqual({
      url: 'https://tasks.orboto.test/upload/tok', expiresAt: '2026-11-04T12:15:00.000Z', targetType: 'ticket', targetKey: 'PRE-289', maxBytes: 52428800, handTo: 'person',
    });
  });

  it('mints for a doc key with a chosen expiry', async () => {
    const calls = mockFetch([{ id: DOC_ID }, link('doc', DOC_ID, 'PRE-D25')]);
    await makeUploadLinkHandler(client)({ docId: 'PRE-D25', expiresInMinutes: 30 });
    expect(calls[0].url).toBe('https://orboto.example.com/docs/by-key/PRE-D25');
    expect(calls[1]).toMatchObject({ url: `https://orboto.example.com/docs/${DOC_ID}/attachments/upload-links`, method: 'POST', body: { expiresInMinutes: 30 } });
  });

  it('needs exactly one target', async () => {
    await expect(makeUploadLinkHandler(client)({})).rejects.toThrow('exactly one of ticketKey or docId');
    await expect(makeUploadLinkHandler(client)({ ticketKey: 'PRE-289', docId: DOC_ID })).rejects.toThrow('exactly one of ticketKey or docId');
  });

  it('is in the curated and full manifests, a non-destructive write that names the base64 bound', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline test'));
    for (const toolset of ['curated', 'full'] as Toolset[]) {
      const server = await buildOrbotoMcpServer({ baseUrl: 'https://orboto.example.com', apiKey: 'orb_test', toolset });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      const mcp = new Client({ name: 'upload-link', version: '0' });
      await Promise.all([server.connect(serverTransport), mcp.connect(clientTransport)]);
      const tool = (await mcp.listTools()).tools.find((t) => t.name === 'orboto_upload_link');
      expect(tool, toolset).toBeDefined();
      expect(tool!.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false });
      expect(tool!.description).toContain('give its URL to the person');
      await mcp.close();
      await server.close();
    }
  });
});
