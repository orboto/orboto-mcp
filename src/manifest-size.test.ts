/**
 * ORB-1521 - manifest-size measurement + regression ratchet (epic
 * ORB-1517).
 *
 * Measures the REAL `tools/list` payload an eager-loading client pays
 * at connect time - through an actual MCP client over an in-memory
 * transport, so the numbers include the SDK's zod->JSON-schema
 * conversion, exactly what Codex/Cursor/Claude Desktop receive.
 *
 * The curated assertion is the RATCHET (mirroring the dark-mode / i18n
 * shrink-only checks): if someone re-registers the tail into the
 * default manifest - or the curated set quietly balloons - this fails
 * before a release ships the token bill. Raising CURATED_MAX_CHARS is a
 * conscious decision to grow the default connect cost, not a formality.
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
 * ORB-1805, measured 2026-09-01 with the schema diet + the compact
 * advertised `__truncation` block: minimal = 12 tools / 9,440 chars;
 * curated = 31 tools / 27,945 chars (was 34,015); full = 175 tools /
 * 142,366 chars (was 152,348).
 *
 * ORB-1669, landed 2026-09-04: every tool carries an MCP `annotations`
 * block (readOnlyHint / destructiveHint / idempotentHint) - clients use
 * them for confirmation UX, so they are spec conformance, not payload
 * fat. Measured cost: minimal +688 chars (12 tools), curated +1,276,
 * full +9,836 (175 tools, ~56 chars each). FULL_MAX_CHARS and
 * MINIMAL_MAX_TOKENS were raised by exactly that, deliberately.
 *
 * ORB-1910 (2026-09-05): orboto_report_feedback joins the curated set (32
 * tools) - an agent that hits a bug must be able to report it without
 * ?toolset=full. Measured curated = 30,652 chars after trimming the tool's
 * schema to the minimum (one describe() on `page`); ceiling re-pinned to
 * 32,500 (~6 % headroom), deliberately, for that one addition.
 */
const CURATED_MAX_CHARS = 32_500;
const FULL_MAX_CHARS = 155_000;

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
 *
 * Why this is not the ticket's aspirational 6,000: measured 2026-09-01,
 * the curated manifest with EVERY description and title stripped out is
 * still 17,379 chars (~4,827 tokens) - 31 tools' names, parameter names,
 * types, enums, plus ~2,700 chars of per-tool `$schema` and `execution`
 * keys the MCP SDK emits and we do not control. A 6,000-token ceiling
 * would leave ~4,200 chars for all 31 tools' text combined, i.e. the
 * one-line summaries and NOTHING else - no "Key (ORB-M3), name, or
 * UUID", no "YYYY-MM-DD", no "Default: task". Those pay for themselves
 * in avoided failed calls. The tier that genuinely fits a small window
 * is `minimal`; curated is the desktop-client default, and this ceiling
 * holds the 18 % the diet won.
 */
// ORB-1910 - re-pinned with CURATED_MAX_CHARS (32,500 / 3.6): the curated set
// gained orboto_report_feedback; measured 8,514 estimated tokens.
const CURATED_SCHEMA_MAX_TOKENS = 9_050;

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
    // Walk pagination defensively; the SDK serves all tools in one page
    // today but the measurement must not silently undercount if that
    // changes.
    let cursor: string | undefined;
    const tools: unknown[] = [];
    do {
      const page = await client.listTools(cursor ? { cursor } : {});
      tools.push(...page.tools);
      cursor = page.nextCursor;
    } while (cursor);
    // `_instructions` verified against @modelcontextprotocol/sdk 1.29.
    // Assert non-empty at the call sites so an SDK rename fails loudly
    // instead of scoring the block as free.
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
    // 31 = the ORB-1741-dieted set + the two ORB-1694 bulk tools (each
    // REPLACES dozens of per-call responses, so they earn their slot).
    expect(count).toBeLessThanOrEqual(32);
    expect(chars).toBeLessThanOrEqual(CURATED_MAX_CHARS);
    expect(estTokens(chars)).toBeLessThanOrEqual(CURATED_SCHEMA_MAX_TOKENS);
  });

  it('full manifest remains available and an order of magnitude larger', async () => {
    const curated = await measuredManifest();
    const full = await measuredManifest('full');
    // eslint-disable-next-line no-console
    console.log(`[manifest-size] full: ${full.count} tools, ${full.chars} chars (~${estTokens(full.chars)} tokens)`);
    expect(full.count).toBeGreaterThan(150);
    // ORB-1741 - the full manifest is ratcheted too: the diet's savings
    // live mostly here (per-tool description essays), so this is where
    // regression would land first.
    expect(full.chars).toBeLessThanOrEqual(FULL_MAX_CHARS);
    // The reduction claim the epic makes - keep it honest in CI.
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
    expect(instructionsChars).toBeGreaterThan(100); // SDK rename guard
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
    // The tier ships the head only: no workspace rules block, so a
    // workspace with a 200-line rule set costs the same as an empty one.
    // (The rules are not lost - orboto_session_start returns them, on
    // the caller's budget rather than as a connect-time tax.) Curated,
    // by contrast, embeds them up to its 4k budget - assert BOTH so this
    // stays a real difference and not a coincidence of the fixture.
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
