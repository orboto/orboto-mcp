/**
 * ORB-510 / ORB-513 — primer-fact tool tests.
 *
 * Each tool is a thin wrapper around a REST endpoint, so the tests
 * pin the wire shape: correct HTTP method, URL with key→UUID
 * resolution, JSON body fields, and the source-coercion contract for
 * the `add` tool's `observed` flag.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OrbotoClient } from '../orboto-client.js';
import {
  makePrimerFactListHandler,
  makePrimerFactAddHandler,
  makePrimerFactUpdateHandler,
  makePrimerFactSupersedeHandler,
  makePrimerFactVerifyHandler,
  makePrimerFactDeleteHandler,
  primerFactAddToolConfig,
  primerFactSupersedeToolConfig,
  primerFactListToolConfig,
} from './primer-facts.js';
import { z } from 'zod';

beforeEach(() => { vi.restoreAllMocks(); });
afterEach(() => { vi.restoreAllMocks(); });

function stub(responses: Array<{ ok?: boolean; status?: number; json?: unknown }>) {
  const calls: Array<{ url: string; method: string; body?: unknown }> = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    const u = url.toString();
    const m = init?.method ?? 'GET';
    const b = init?.body ? JSON.parse(init.body as string) : undefined;
    calls.push({ url: u, method: m, body: b });
    const r = responses.shift();
    if (!r) throw new Error(`unexpected extra fetch ${m} ${u}`);
    return {
      ok: r.ok ?? true,
      status: r.status ?? 200,
      statusText: 'OK',
      json: async () => ('json' in r ? r.json : {}),
      text: async () => '',
    } as unknown as Response;
  });
  return calls;
}

const client = new OrbotoClient({ baseUrl: 'https://orboto.example.com', apiKey: 'orb_x' });

const projectStub = { id: 'p-uuid-1234', key: 'ORB', name: 'orboto', description: null, status: 'active' };
const factStub = {
  id: 'f-uuid-1111',
  projectId: 'p-uuid-1234',
  category: 'tech_stack',
  key: 'package-manager',
  value: 'pnpm 9',
  source: 'manual',
  verified: false,
  verifiedBy: null,
  verifiedAt: null,
  lastVerifiedAt: '2026-04-30T10:00:00Z',
  supersededById: null,
  createdBy: 'u-uuid-1',
  createdAt: '2026-04-30T10:00:00Z',
  updatedAt: '2026-04-30T10:00:00Z',
};

// ---------------------------------------------------------------------------
// orboto_primer_fact_list
// ---------------------------------------------------------------------------

describe('orboto_primer_fact_list', () => {
  it('resolves projectKey then GETs /projects/<id>/primer-facts with filters', async () => {
    const calls = stub([
      { json: projectStub },
      {
        json: [
          factStub,
          {
            ...factStub,
            id: 'f-2',
            projectId: null,
            category: 'conventions',
            key: 'branching',
            value: 'develop -> release',
          },
        ],
      },
    ]);
    const res = await makePrimerFactListHandler(client)({
      projectKey: 'ORB',
      category: 'tech_stack',
      verified: false,
      includeWorkspace: true,
    });
    expect(calls[0].url).toContain('/projects/by-key/ORB');
    expect(calls[1].url).toContain(`/projects/${projectStub.id}/primer-facts?`);
    expect(calls[1].url).toContain('category=tech_stack');
    expect(calls[1].url).toContain('verified=false');
    expect(calls[1].url).toContain('includeWorkspace=true');
    expect(calls[1].method).toBe('GET');

    const text = (res.content[0] as { text: string }).text;
    expect(text).toContain('[project]');
    expect(text).toContain('[workspace]');
    expect(text).toContain('tech_stack/package-manager');
    expect(text).toContain('conventions/branching');
  });

  it('defaults includeWorkspace to true on the wire', async () => {
    const calls = stub([
      { json: projectStub },
      { json: [] },
    ]);
    await makePrimerFactListHandler(client)({ projectKey: 'ORB' });
    expect(calls[1].url).toContain('includeWorkspace=true');
  });

  it('renders an empty-state message when no facts match', async () => {
    stub([
      { json: projectStub },
      { json: [] },
    ]);
    const res = await makePrimerFactListHandler(client)({ projectKey: 'ORB' });
    expect((res.content[0] as { text: string }).text).toBe('No primer facts in scope.');
  });

  it('rewrites a 403 into a permission-clarifying error', async () => {
    stub([
      { json: projectStub },
      { ok: false, status: 403, json: { error: 'Forbidden' } },
    ]);
    await expect(
      makePrimerFactListHandler(client)({ projectKey: 'ORB' })
    ).rejects.toThrow(/project:edit|admin:ai:write/);
  });

  it('input schema rejects an unknown category', () => {
    const schema = z.object(primerFactListToolConfig.inputSchema);
    const result = schema.safeParse({ projectKey: 'ORB', category: 'nonsense' });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// orboto_primer_fact_add
// ---------------------------------------------------------------------------

describe('orboto_primer_fact_add', () => {
  it('observed=false (default) sends source=manual', async () => {
    const calls = stub([
      { json: projectStub },
      { json: factStub },
    ]);
    await makePrimerFactAddHandler(client)({
      projectKey: 'ORB',
      category: 'tech_stack',
      key: 'package-manager',
      value: 'pnpm 9',
    });
    expect(calls[1].method).toBe('POST');
    expect(calls[1].url).toContain(`/projects/${projectStub.id}/primer-facts`);
    expect(calls[1].body).toMatchObject({
      category: 'tech_stack',
      key: 'package-manager',
      value: 'pnpm 9',
      source: 'manual',
    });
  });

  it('observed=true sends source=agent_observed', async () => {
    const calls = stub([
      { json: projectStub },
      { json: { ...factStub, source: 'agent_observed' } },
    ]);
    await makePrimerFactAddHandler(client)({
      projectKey: 'ORB',
      category: 'gotchas',
      key: 'firefox-cors',
      value: 'Firefox rejects presigned S3 URLs from internal hosts',
      observed: true,
    });
    expect(calls[1].body).toMatchObject({ source: 'agent_observed' });
  });

  it('rewrites a 409 into a "use supersede" hint', async () => {
    stub([
      { json: projectStub },
      { ok: false, status: 409, json: { error: 'duplicate', errorKey: 'errors.primer_facts.duplicate_key' } },
    ]);
    await expect(
      makePrimerFactAddHandler(client)({
        projectKey: 'ORB',
        category: 'tech_stack',
        key: 'package-manager',
        value: 'yarn',
      })
    ).rejects.toThrow(/orboto_primer_fact_supersede/);
  });

  it('input schema rejects an empty key', () => {
    const schema = z.object(primerFactAddToolConfig.inputSchema);
    const result = schema.safeParse({
      projectKey: 'ORB',
      category: 'tech_stack',
      key: '',
      value: 'v',
    });
    expect(result.success).toBe(false);
  });

  it('input schema rejects an unknown category', () => {
    const schema = z.object(primerFactAddToolConfig.inputSchema);
    const result = schema.safeParse({
      projectKey: 'ORB',
      category: 'nonsense',
      key: 'k',
      value: 'v',
    });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// orboto_primer_fact_update
// ---------------------------------------------------------------------------

describe('orboto_primer_fact_update', () => {
  it('PATCHes /primer-facts/<id> with only the provided fields', async () => {
    const calls = stub([{ json: { ...factStub, value: 'pnpm 10' } }]);
    await makePrimerFactUpdateHandler(client)({
      factId: factStub.id,
      value: 'pnpm 10',
    });
    expect(calls[0].method).toBe('PATCH');
    expect(calls[0].url).toContain(`/primer-facts/${factStub.id}`);
    expect(calls[0].body).toEqual({ value: 'pnpm 10' });
  });

  it('throws when called with no fields to update', async () => {
    await expect(
      makePrimerFactUpdateHandler(client)({ factId: factStub.id })
    ).rejects.toThrow(/at least one of/);
  });

  it('rewrites a 404 into a "target not found" error', async () => {
    stub([{ ok: false, status: 404, json: { error: 'Not found' } }]);
    await expect(
      makePrimerFactUpdateHandler(client)({ factId: 'missing', value: 'v' })
    ).rejects.toThrow(/not found/);
  });
});

// ---------------------------------------------------------------------------
// orboto_primer_fact_supersede
// ---------------------------------------------------------------------------

describe('orboto_primer_fact_supersede', () => {
  it('POSTs /primer-facts/<id>/supersede with category + key + value', async () => {
    const calls = stub([{ json: { ...factStub, id: 'new-uuid', value: 'pnpm 10' } }]);
    await makePrimerFactSupersedeHandler(client)({
      oldFactId: factStub.id,
      category: 'tech_stack',
      key: 'package-manager',
      value: 'pnpm 10',
    });
    expect(calls[0].method).toBe('POST');
    expect(calls[0].url).toContain(`/primer-facts/${factStub.id}/supersede`);
    expect(calls[0].body).toEqual({
      category: 'tech_stack',
      key: 'package-manager',
      value: 'pnpm 10',
    });
  });

  it('input schema rejects missing required fields', () => {
    const schema = z.object(primerFactSupersedeToolConfig.inputSchema);
    expect(schema.safeParse({ oldFactId: 'x', category: 'tech_stack', key: 'k' }).success).toBe(false);
    expect(schema.safeParse({ oldFactId: 'x' }).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// orboto_primer_fact_verify
// ---------------------------------------------------------------------------

describe('orboto_primer_fact_verify', () => {
  it('POSTs /primer-facts/<id>/verify with empty body', async () => {
    const calls = stub([{ json: { ...factStub, verified: true, verifiedBy: 'u1', verifiedAt: 'now' } }]);
    await makePrimerFactVerifyHandler(client)({ factId: factStub.id });
    expect(calls[0].method).toBe('POST');
    expect(calls[0].url).toContain(`/primer-facts/${factStub.id}/verify`);
    expect(calls[0].body).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// orboto_primer_fact_delete
// ---------------------------------------------------------------------------

describe('orboto_primer_fact_delete', () => {
  it('DELETEs /primer-facts/<id>', async () => {
    const calls = stub([{ status: 204 }]);
    const res = await makePrimerFactDeleteHandler(client)({ factId: factStub.id });
    expect(calls[0].method).toBe('DELETE');
    expect(calls[0].url).toContain(`/primer-facts/${factStub.id}`);
    const text = (res.content[0] as { text: string }).text;
    expect(text).toContain('Deleted primer fact');
  });

  it('echoes the optional reason in the text output', async () => {
    stub([{ status: 204 }]);
    const res = await makePrimerFactDeleteHandler(client)({
      factId: factStub.id,
      reason: 'fact was wrong from the start',
    });
    const text = (res.content[0] as { text: string }).text;
    expect(text).toContain('fact was wrong from the start');
  });

  it('rewrites a 404 into a "target not found" error', async () => {
    stub([{ ok: false, status: 404, json: { error: 'Not found' } }]);
    await expect(
      makePrimerFactDeleteHandler(client)({ factId: 'missing' })
    ).rejects.toThrow(/not found/);
  });
});

// ORB-1819 - the writing-for-tokens size contract, passed through from the
// REST route's warn (200/201 + sizeWarning) / block (422) responses.
describe('ORB-1819 size contract', () => {
  it('add surfaces a soft-limit sizeWarning in the success text, not as an error', async () => {
    stub([
      { json: projectStub },
      { status: 201, json: { ...factStub, value: 'x'.repeat(320), sizeWarning: { chars: 320, limit: 300, hint: 'move it to a doc' } } },
    ]);
    const res = await makePrimerFactAddHandler(client)({
      projectKey: 'ORB', category: 'tech_stack', key: 'long-fact', value: 'x'.repeat(320),
    });
    expect(res.isError).toBeUndefined();
    const text = (res.content[0] as { text: string }).text;
    expect(text).toContain('320 chars');
    expect(text).toContain('move it to a doc');
  });

  it('add turns a hard-cap 422 into a non-throwing blocked result carrying the override recipe', async () => {
    const blockBody = JSON.stringify({
      error: 'oversize', errorKey: 'errors.agent_content.oversize',
      sizeWarning: { chars: 650, limit: 600, hint: 'move it to a doc and keep the doc key here' },
    });
    let call = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      call += 1;
      if (call === 1) return { ok: true, status: 200, statusText: 'OK', json: async () => projectStub, text: async () => '' } as unknown as Response;
      return { ok: false, status: 422, statusText: 'Unprocessable', json: async () => ({}), text: async () => blockBody } as unknown as Response;
    });
    const res = await makePrimerFactAddHandler(client)({
      projectKey: 'ORB', category: 'tech_stack', key: 'way-too-long', value: 'x'.repeat(650),
    });
    expect(res.isError).toBe(true);
    const text = (res.content[0] as { text: string }).text;
    expect(text).toContain('650');
    expect(text).toContain('allowOversize=true');
    expect(text).toContain('oversizeReason');
    const sc = res.structuredContent as { blocked: boolean; sizeWarning: { limit: number } };
    expect(sc.blocked).toBe(true);
    expect(sc.sizeWarning.limit).toBe(600);
  });

  it('add passes allowOversize + oversizeReason through to the POST body', async () => {
    const calls = stub([
      { json: projectStub },
      { status: 201, json: { ...factStub, sizeWarning: { chars: 650, limit: 600, hint: 'h' } } },
    ]);
    await makePrimerFactAddHandler(client)({
      projectKey: 'ORB', category: 'tech_stack', key: 'k', value: 'x'.repeat(650),
      allowOversize: true, oversizeReason: 'genuinely needs the full spec',
    });
    expect(calls[1].body).toMatchObject({ allowOversize: true, oversizeReason: 'genuinely needs the full spec' });
  });

  it('update turns a hard-cap 422 into a non-throwing blocked result', async () => {
    const blockBody = JSON.stringify({
      error: 'oversize', errorKey: 'errors.agent_content.oversize',
      sizeWarning: { chars: 700, limit: 600, hint: 'shorten it' },
    });
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => (
      { ok: false, status: 422, statusText: 'Unprocessable', json: async () => ({}), text: async () => blockBody } as unknown as Response
    ));
    const res = await makePrimerFactUpdateHandler(client)({ factId: factStub.id, value: 'x'.repeat(700) });
    expect(res.isError).toBe(true);
    const sc = res.structuredContent as { blocked: boolean };
    expect(sc.blocked).toBe(true);
  });

  it('supersede turns a hard-cap 422 into a non-throwing blocked result', async () => {
    const blockBody = JSON.stringify({
      error: 'oversize', errorKey: 'errors.agent_content.oversize',
      sizeWarning: { chars: 700, limit: 600, hint: 'shorten it' },
    });
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => (
      { ok: false, status: 422, statusText: 'Unprocessable', json: async () => ({}), text: async () => blockBody } as unknown as Response
    ));
    const res = await makePrimerFactSupersedeHandler(client)({
      oldFactId: factStub.id, category: 'tech_stack', key: 'k', value: 'x'.repeat(700),
    });
    expect(res.isError).toBe(true);
    const sc = res.structuredContent as { blocked: boolean };
    expect(sc.blocked).toBe(true);
  });
});
