/**
 * ORB-1521 - manifest-size measurement + regression ratchet (epic
 * ORB-1517).
 */
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildOrbotoMcpServer } from './server.js';
import type { Toolset } from './toolset.js';

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline test'));
  delete process.env.ORBOTO_MCP_TOOLSET;
});
afterEach(() => { vi.restoreAllMocks(); });

/**
 * Measured 2026-08-10 (ORB-1521): curated = 28 tools / 37,458 chars
 * (~9.4k tokens); full = 171 tools / 189,672 chars (~47.4k tokens).
 * Re-measured 2026-08-28 after the ORB-1741 manifest diet (one-line
 * descriptions + orboto_help): curated = 29 tools / 27,870 chars
 * (~7.0k tokens); full = 173 tools / 145,867 chars (~36.5k tokens).
 * ORB-1694 added the two bulk tools (create + dependencies, schema-heavy
 * by nature): curated = 31 tools / 33,615 chars - still below the
 * pre-diet 37,458 baseline. Ceilings keep ~7-10 % headroom for honest
 * edits - a description essay creeping back in is exactly what these
 * must catch, so the headroom is deliberately tighter than the old
 * 20 %. Shrink-only: raising either number is a conscious decision to
 * grow every session's connect cost.
 *
 * @see ORB-1805, ORB-1669, ORB-1910
 */
const CURATED_MAX_CHARS = 37_500;
const FULL_MAX_CHARS = 165_000;

/**
 * ORB-1805 - the estimator the ticket measured the failure with
 * (`n_keep: 13533 >= n_ctx: 8192` in LM Studio): characters / 3.6. It is
 * a rough tokenizer stand-in, deliberately the SAME rough number the
 * ticket, the docs page and these ceilings all use, so the figures a
 * reader compares are comparable.
 */
const CHARS_PER_TOKEN = 3.6;
const estTokens = (chars: number) => Math.round(chars / CHARS_PER_TOKEN);

/**
 * The minimal tier's whole connect cost - tool schemas AND the
 * instructions block - must fit a small local model's window with room
 * left for the conversation. 3,000 was the ticket's number; 3,100 since
 * ORB-1669 added the annotations block to every tool (+688 chars).
 */
const MINIMAL_MAX_TOKENS = 3_100;

/**
 * The curated tier is ratcheted on its TOOL SCHEMAS (the instructions
 * block has its own budget, enforced in instructions-budget.test.ts).
 */
const CURATED_SCHEMA_MAX_TOKENS = 10_450;

interface Measurement { count: number; chars: number; instructionsChars: number }

async function measuredManifest(toolset?: Toolset): Promise<Measurement> {
  const server = await buildOrbotoMcpServer({
    baseUrl: 'https://orboto.example.com',
    apiKey: 'orb_test',
    ...(toolset ? { toolset } : {}),
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'manifest-measure', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    let cursor: string | undefined;
    const tools: unknown[] = [];
    do {
      const page = await client.listTools(cursor ? { cursor } : {});
      tools.push(...page.tools);
      cursor = page.nextCursor;
    } while (cursor);
    const instructions = String(
      (server as unknown as { server: { _instructions?: string } }).server._instructions ?? '',
    );
    return { count: tools.length, chars: JSON.stringify(tools).length, instructionsChars: instructions.length };
  } finally {
    await client.close();
    await server.close();
  }
}

describe('ORB-1521 - eager-load manifest size', () => {
  it('curated manifest stays under the ratchet ceiling', async () => {
    const { count, chars } = await measuredManifest();
    // eslint-disable-next-line no-console
    console.log(`[manifest-size] curated: ${count} tools, ${chars} chars (~${estTokens(chars)} tokens)`);
    expect(count).toBeLessThanOrEqual(36);
    expect(chars).toBeLessThanOrEqual(CURATED_MAX_CHARS);
    expect(estTokens(chars)).toBeLessThanOrEqual(CURATED_SCHEMA_MAX_TOKENS);
  });

  it('full manifest remains available and an order of magnitude larger', async () => {
    const curated = await measuredManifest();
    const full = await measuredManifest('full');
    // eslint-disable-next-line no-console
    console.log(`[manifest-size] full: ${full.count} tools, ${full.chars} chars (~${estTokens(full.chars)} tokens)`);
    expect(full.count).toBeGreaterThan(150);
    expect(full.chars).toBeLessThanOrEqual(FULL_MAX_CHARS);
    expect(full.chars / curated.chars).toBeGreaterThan(3);
  });
});

/**
 * ORB-1805 - the small-context tier.
 *
 * This is the assertion that keeps the tier honest: an 8k local model
 * pays the WHOLE connect cost (schemas + instructions) before its own
 * first turn, so both halves are measured together against one ceiling.
 */
describe('ORB-1805 - minimal manifest fits a small context window', () => {
  it('minimal: schemas + instructions stay under 3k estimated tokens', async () => {
    const { count, chars, instructionsChars } = await measuredManifest('minimal');
    const total = chars + instructionsChars;
    // eslint-disable-next-line no-console
    console.log(
      `[manifest-size] minimal: ${count} tools, ${chars} chars (~${estTokens(chars)} tokens)`
      + ` + instructions ${instructionsChars} chars (~${estTokens(instructionsChars)} tokens)`
      + ` = ~${estTokens(total)} tokens`,
    );
    expect(count).toBe(12);
    expect(instructionsChars).toBeGreaterThan(100);
    expect(estTokens(total)).toBeLessThanOrEqual(MINIMAL_MAX_TOKENS);
  });

  it('minimal is a strict subset of curated, which is a strict subset of full', async () => {
    const minimal = await measuredManifest('minimal');
    const curated = await measuredManifest();
    const full = await measuredManifest('full');
    expect(minimal.count).toBeLessThan(curated.count);
    expect(curated.count).toBeLessThan(full.count);
    expect(minimal.chars).toBeLessThan(curated.chars);
  });

  it('minimal instructions are a CONSTANT - a long workspace rule set cannot grow them', async () => {
    const offline = await measuredManifest('minimal');

    const hugeRules = Array.from({ length: 200 }, (_, i) => `rule ${i}: ${'x'.repeat(60)}`).join('\n');
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => ({ instructions: hugeRules }),
      text: async () => JSON.stringify({ instructions: hugeRules }),
    } as unknown as Response);

    const loaded = await measuredManifest('minimal');
    expect(loaded.instructionsChars).toBe(offline.instructionsChars);
    expect(loaded.instructionsChars).toBeLessThanOrEqual(1_000);

    const curated = await measuredManifest();
    expect(curated.instructionsChars).toBeGreaterThan(loaded.instructionsChars);
  });
});
