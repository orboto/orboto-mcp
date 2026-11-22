/**
 * ORB-3188 - `orboto_design` handler tests: `get` reads a design by handle and lists a project's designs by its key, a bad payload fails before any
 * request, the actions of later rows say so, and the local mirrors match the shared schema.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OrbotoClient } from '../orboto-client.js';
import { DESIGN_ACTIONS, DESIGN_FORMS, DESIGN_KINDS, designToolConfig, makeDesignHandler } from './design.js';

beforeEach(() => { vi.restoreAllMocks(); });
afterEach(() => { vi.restoreAllMocks(); });

function stub(responses: Array<{ json: unknown; status?: number }>) {
  const calls: Array<{ url: string; method: string }> = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    calls.push({ url: url.toString(), method: init?.method ?? 'GET' });
    const r = responses.shift();
    if (!r) throw new Error(`unexpected extra fetch ${url}`);
    const status = r.status ?? 200;
    return { ok: status < 400, status, statusText: status < 400 ? 'OK' : 'Not Found', json: async () => r.json, text: async () => JSON.stringify(r.json) } as unknown as Response;
  });
  return calls;
}

const client = new OrbotoClient({ baseUrl: 'https://orboto.example.com', apiKey: 'orb_x' });
const subject = {
  id: '11111111-1111-4111-8111-111111111111', handle: 'ALPHA-D7', kind: 'concept', form: 'compact', touchesContract: true, fingerprint: '9c1e0a2b3c4d5e6f', fingerprintAlgo: 'sha256-content-v1',
  anchor: { type: 'doc', id: '22222222-2222-4222-8222-222222222222', key: 'ALPHA-D7', title: 'Sync concept' },
  homeProject: { id: '33333333-3333-4333-8333-333333333333', key: 'ALPHA', name: 'Alpha' },
  author: { kind: 'agent', label: 'Builder', model: 'claude-opus-5-5', modelSource: 'declared' },
  buildTickets: [{ ticketId: '44444444-4444-4444-8444-444444444444', key: 'ALPHA-12', title: 'Build the sync' }],
  buildTicketsVisible: 1, buildTicketsOmitted: 0, buildTicketsHidden: 2, updatedAt: '2026-11-22T08:00:00.000Z',
};
const text = (out: { content: unknown[] }) => (out.content[0] as { text: string }).text;

describe('orboto_design', () => {
  it('declares a short title, only the action that works today and explicit annotations, naming what A2 and A3 add', () => {
    expect(designToolConfig.title.length).toBeLessThanOrEqual(64);
    expect(designToolConfig.inputSchema.action.options).toEqual(['get']);
    expect(designToolConfig.description).toMatch(/review, question, answer and payload section, point come with A2 and A3/);
    expect(designToolConfig.description).not.toMatch(/confirm/);
    expect(Object.keys(designToolConfig.inputSchema).sort()).toEqual(['action', 'handle', 'payload']);
    expect(designToolConfig.annotations).toEqual({ readOnlyHint: false, destructiveHint: false, idempotentHint: false });
  });

  it('passes a handle to the one read route unchanged and shows its 404 as it came, so a hidden ticket and a missing key read alike', async () => {
    const body = { error: 'Not found', errorKey: 'errors.design_reviews.not_found' };
    const calls = stub([{ status: 404, json: body }, { status: 404, json: body }]);
    const hidden = await makeDesignHandler(client)({ action: 'get', handle: 'ALPHA-12' }).then(() => '', (e: Error) => e.message);
    const missing = await makeDesignHandler(client)({ action: 'get', handle: 'ALPHA-99' }).then(() => '', (e: Error) => e.message);
    expect(calls.map((c) => c.url)).toEqual(['https://orboto.example.com/design-subjects/ALPHA-12', 'https://orboto.example.com/design-subjects/ALPHA-99']);
    expect(hidden.replace('ALPHA-12', 'X')).toBe(missing.replace('ALPHA-99', 'X'));
  });

  it('reads a design by its handle with the read-time fingerprint and its build tickets, hidden ones counted', async () => {
    const calls = stub([{ json: subject }]);
    const out = await makeDesignHandler(client)({ action: 'get', handle: 'ALPHA-D7' });
    expect(calls).toEqual([{ url: 'https://orboto.example.com/design-subjects/ALPHA-D7', method: 'GET' }]);
    expect(text(out)).toBe([
      'ALPHA-D7 concept touches-contract fp=9c1e0a2b3c4d5e6f home=ALPHA by Builder (agent) on claude-opus-5-5 (declared) - Sync concept',
      '- builds ALPHA-12 Build the sync',
      '2 build tickets you cannot see',
    ].join('\n'));
    expect(out.structuredContent).toEqual(subject);
  });

  it('asks for the full form and lists a project by its key with the next cursor', async () => {
    const calls = stub([{ json: { ...subject, form: 'full' } }, { json: { items: [{ ...subject, authorLabel: 'Builder', authorModel: null }], nextCursor: 'c2' } }]);
    await makeDesignHandler(client)({ action: 'get', handle: 'ALPHA-12', payload: { form: 'full' } });
    const listed = await makeDesignHandler(client)({ action: 'get', handle: 'ALPHA', payload: { cursor: 'c1' } });
    expect(calls.map((c) => c.url)).toEqual(['https://orboto.example.com/design-subjects/ALPHA-12?form=full', 'https://orboto.example.com/design-subjects?projectId=ALPHA&limit=50&cursor=c1']);
    expect(text(listed)).toBe('- ALPHA-D7 concept touches-contract by Builder, 1 build tickets, changed 2026-11-22T08:00:00.000Z - Sync concept\nMore: payload cursor=c2');
  });

  it('refuses a payload field get does not take, section and point included, before any request', async () => {
    const calls = stub([]);
    await expect(makeDesignHandler(client)({ action: 'get', handle: 'ALPHA-D7', payload: { form: 'wide' } })).rejects.toThrow(/get payload: form/);
    await expect(makeDesignHandler(client)({ action: 'get', handle: 'ALPHA-D7', payload: { section: 'readings' } })).rejects.toThrow(/get payload/);
    await expect(makeDesignHandler(client)({ action: 'get', handle: 'ALPHA-D7', payload: { point: 'P1' } })).rejects.toThrow(/get payload/);
    await expect(makeDesignHandler(client)({ action: 'get', handle: ' ' })).rejects.toThrow(/needs handle/);
    expect(calls).toEqual([]);
  });

  it('mirrors the kind and form enums of the shared schema', () => {
    const canonical = readFileSync(path.resolve(process.cwd(), '../../packages/shared-schema/src/design-reviews.ts'), 'utf8');
    const enumOf = (name: string) => canonical.match(new RegExp(`${name} = z\\.enum\\(\\[([^\\]]+)\\]`))?.[1].match(/'([^']+)'/g)?.map((value) => value.slice(1, -1));
    expect(enumOf('DesignSubjectKindSchema')).toEqual([...DESIGN_KINDS]);
    expect(enumOf('DesignFormSchema')).toEqual([...DESIGN_FORMS]);
    expect(canonical).toContain('cursor: z.string().max(2048).optional()');
    expect(DESIGN_ACTIONS).toEqual(['get']);
  });
});
