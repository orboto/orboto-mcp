/**
 * ORB-1805 - the schema diet must never cost a PARAMETER.
 *
 * The diet trims description text: tool prose moved into
 * `orboto_help` / the skill's REFERENCE.md, per-parameter prose
 * shortened to the phrase a caller acts on. What it must never do is
 * drop a field, flip a required field to optional, or shrink an enum -
 * those are the changes that silently break a caller.
 *
 * `tool-parameters.baseline.json` is the snapshot taken from the FULL
 * manifest immediately BEFORE the ORB-1805 diet: for every tool, every
 * property path in its input schema (nested objects and array items
 * included, as dotted paths), its required list, and every enum's
 * values. This test walks the live manifest the same way and fails on
 * any loss.
 *
 * Direction matters: it is a SUPERSET check. Adding a parameter, making
 * a required one optional-to-required is caught, and adding an enum
 * value is fine - only removal fails. Re-baseline ONLY when a parameter
 * is intentionally removed (which is an API break in its own right and
 * belongs in its own ticket), never to make this test go quiet.
 */
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildOrbotoMcpServer } from './server.js';

interface ToolShape {
  params: string[];
  required: string[];
  enums: Record<string, string[]>;
}

const baseline: Record<string, ToolShape> = JSON.parse(
  readFileSync(fileURLToPath(new URL('./tool-parameters.baseline.json', import.meta.url)), 'utf8'),
);

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline test'));
  delete process.env.ORBOTO_MCP_TOOLSET;
});
afterEach(() => { vi.restoreAllMocks(); });

type JsonSchema = {
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema;
  anyOf?: JsonSchema[];
  oneOf?: JsonSchema[];
  allOf?: JsonSchema[];
  enum?: unknown[];
  required?: string[];
};

/** Same walk the baseline was generated with: dotted property paths,
 *  `[]` for an array hop, union branches flattened onto the same path. */
function walk(schema: JsonSchema | undefined, prefix: string, params: Set<string>, enums: Record<string, Set<string>>): void {
  if (!schema || typeof schema !== 'object') return;
  if (Array.isArray(schema.enum) && prefix) {
    (enums[prefix] ??= new Set());
    for (const v of schema.enum) enums[prefix].add(String(v));
  }
  for (const branch of [schema.anyOf, schema.oneOf, schema.allOf]) {
    if (Array.isArray(branch)) for (const s of branch) walk(s, prefix, params, enums);
  }
  if (schema.items) walk(schema.items, `${prefix}[]`, params, enums);
  if (schema.properties) {
    for (const [k, v] of Object.entries(schema.properties)) {
      const p = prefix ? `${prefix}.${k}` : k;
      params.add(p);
      walk(v, p, params, enums);
    }
  }
}

async function liveShapes(): Promise<Record<string, ToolShape>> {
  const server = await buildOrbotoMcpServer({
    baseUrl: 'https://orboto.example.com',
    apiKey: 'orb_test',
    toolset: 'full',
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'param-shape', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    let cursor: string | undefined;
    const tools: Array<{ name: string; inputSchema?: JsonSchema }> = [];
    do {
      const page = await client.listTools(cursor ? { cursor } : {});
      tools.push(...(page.tools as typeof tools));
      cursor = page.nextCursor;
    } while (cursor);
    const out: Record<string, ToolShape> = {};
    for (const t of tools) {
      const params = new Set<string>();
      const enums: Record<string, Set<string>> = {};
      walk(t.inputSchema, '', params, enums);
      out[t.name] = {
        params: [...params].sort(),
        required: (t.inputSchema?.required ?? []).slice().sort(),
        enums: Object.fromEntries(Object.entries(enums).map(([k, v]) => [k, [...v].sort()])),
      };
    }
    return out;
  } finally {
    await client.close();
    await server.close();
  }
}

describe('ORB-1805 - no parameter lost to the schema diet', () => {
  it('the baseline fixture is the pre-diet full manifest, not an empty file', () => {
    expect(Object.keys(baseline).length).toBeGreaterThan(150);
    expect(baseline.orboto_create_ticket?.params).toContain('duplicateJustification');
    expect(baseline.orboto_update_ticket?.params).toContain('patch.customerSummary');
  });

  it('every tool in the baseline still exists', async () => {
    const live = await liveShapes();
    const missing = Object.keys(baseline).filter((t) => !live[t]);
    expect(missing).toEqual([]);
  });

  it('every baseline parameter path still exists on its tool', async () => {
    const live = await liveShapes();
    const lost: string[] = [];
    for (const [tool, shape] of Object.entries(baseline)) {
      for (const p of shape.params) {
        if (!live[tool]?.params.includes(p)) lost.push(`${tool}.${p}`);
      }
    }
    expect(lost).toEqual([]);
  });

  it('no required parameter became optional (and none appeared)', async () => {
    const live = await liveShapes();
    const changed: string[] = [];
    for (const [tool, shape] of Object.entries(baseline)) {
      const now = live[tool]?.required ?? [];
      for (const r of shape.required) if (!now.includes(r)) changed.push(`${tool}.${r} no longer required`);
      for (const r of now) if (!shape.required.includes(r)) changed.push(`${tool}.${r} newly required`);
    }
    expect(changed).toEqual([]);
  });

  it('no enum value disappeared', async () => {
    const live = await liveShapes();
    const lost: string[] = [];
    for (const [tool, shape] of Object.entries(baseline)) {
      for (const [path, values] of Object.entries(shape.enums)) {
        const now = live[tool]?.enums[path] ?? [];
        for (const v of values) if (!now.includes(v)) lost.push(`${tool}.${path}: "${v}"`);
      }
    }
    expect(lost).toEqual([]);
  });
});
