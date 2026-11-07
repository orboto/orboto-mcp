/**
 * ORB-1521 - manifest-size measurement + regression ratchet (epic
 * ORB-1517).
 */
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildOrbotoMcpServer } from './server.js';
import type { Toolset } from './toolset.js';
import { tokensForChars } from './token-size.js';

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
 * grow every session's connect cost. ORB-2132 raised the full ceiling by
 * 2,000 chars because the agent_presence output schema now carries kind,
 * actsAs, projects and connections (measured full = 165,759 chars).
 * ORB-2136 raised all three: session_start and agent_heartbeat carry the
 * session scope schema, agent_notify the toSessionRef, and orboto_messages
 * renders sender and receiver identities in its output schema (measured
 * curated = 38,640, full = 168,029 chars, minimal = 3,140 tokens).
 * ORB-2150 raised the curated ceiling to 39,700: `orboto_messages` gained
 * the `dismiss` envelope and the per-message `dismissed` record, which is
 * the surface that stops foreign mail from waking every session of a
 * shared account (measured curated = 39,461 chars / 10,961 tokens).
 * ORB-2149 raised the full ceiling to 171,200: `orboto_agent_wakes` puts
 * the wake ledger and the delivery precision per session and per sender
 * in the full toolset (measured full = 170,030 chars); the curated tier
 * reaches it through the escape hatch and is unchanged.
 * ORB-2162 raised the curated ceiling to 39,900 and the curated token
 * ceiling to 11,100: `orboto_create_ticket` gained `dryRun`, the pre-flight
 * that returns the language, type, label and duplicate verdicts before the
 * write instead of after it (measured curated = 39,679 chars / 11,022
 * tokens, from 39,461 / 10,961 - one boolean parameter, no new tool). The
 * verdicts themselves ride the response, not the manifest.
 * ORB-2338 added no named tool; the transcript rides the escape hatch and
 * the resource.
 * ORB-2465 added no named tool: the live notice rides the escape hatch
 * (full = 171,194 chars, 6 free).
 * ORB-2502 gave `orboto_messages` a `since` parameter inside the ceiling: the
 * limit lost its schema default and the project hint shrank (full = 171,197).
 * ORB-2542 added no named tool: the owner lookup rides `orboto_who` `for` and
 * the escape hatch; the route/forceTarget parameters fit after tightening the
 * agent_notify description.
 * ORB-2546 gave `orboto_list_tickets` a described `sort` enum inside the
 * ceiling: its parameter descriptions shrank to pay for it (full = 171,197).
 * ORB-2544 added no named tool: ending a session rides the escape hatch;
 * orboto_who `state` and the agent_presence redaction line fit after the
 * agent_presence summary shrank (full = 171,160).
 * ORB-2563 gave `orboto_agent_notify` `remind` and `urgent` inside the
 * ceiling: the docs `content` parameter description shrank to pay for it
 * (full = 171,194).
 * ORB-2579 added the four rule proposal tools to the full tier after
 * tightening repeated parameter descriptions (doc ids, bulk selectors,
 * work-session leases, primer facts) by 3.0k (full = 169,607).
 * ORB-2684 gave the scope input of `orboto_session_start` and
 * `orboto_agent_heartbeat` the `account` boolean (+58) inside the ceiling:
 * both titles and the session_start summary shrank to pay for it
 * (full = 171,194).
 * ORB-2687 gave `orboto_close_ticket`, `orboto_move_ticket`,
 * `orboto_bulk_move_tickets` and `orboto_bulk_close_tickets` `keepTimer`
 * inside the ceiling: their first sentences, comment parameters and the
 * shared bulk selector descriptions shrank to pay for it (full = 171,141).
 * ORB-2711 gave `orboto_list_tickets` `includeClosedMilestones` inside the
 * ceiling: the parameter carries no description (the answer names the hidden
 * count and the parameter) and the first sentence shrank (full = 171,171).
 * ORB-2719 added `orboto_connector` inside the ceiling: four agent actions
 * (source_link, list, health, sync), the operator tail through
 * orboto_api_call, paid for by shorter doc-id, review, lease and checklist
 * parameter descriptions (full = 171,118).
 * ORB-2773 added `orboto_primer_fact_history`, gave add and supersede
 * `evidence` and `orboto_primer_fact_verify` `pinned` inside the ceiling:
 * the primer fact parameter descriptions and the add summary shrank to pay
 * for it (full = 171,134). Its review shortened the repeated doc id,
 * project key, cursor, lease and oversize parameter descriptions to leave
 * 1,013 chars of headroom (full = 170,187).
 * ORB-2766 added `orboto_knowledge_find` inside the ceiling: the whoami, cross-project-links and docs-in-space first sentences and the search_docs summary shrank to pay for it (full = 171,178).
 * ORB-2767 added `orboto_knowledge_undo` (+481) inside the ceiling: doc,
 * wiki and primer fact titles and the edit summaries shrank to pay for it
 * (the search and list-in-space summaries stay as ORB-2766 shortened them),
 * and the save-answer summary no longer stops at "e.g." (full = 170,552 on
 * top of ORB-2766, from 171,178; curated = 39,277).
 * ORB-2790 added `orboto_session_digest` (+464, full tier only) inside the
 * ceiling: one optional sessionId without a description and a one-sentence
 * summary (full = 171,133 from 170,669; curated unchanged at 39,394).
 * ORB-2799 won the headroom back without dropping a parameter: titles, first
 * sentences and parameter texts lost what the schema or the parameter name
 * already says, repeated texts became shared constants, the pill tones moved
 * to the create_doc guidance (full = 166,377 from 171,133; the full ceiling
 * 171,200 became 169,400, which keeps 3,023 chars free for the next tool).
 * ORB-2802 gave `orboto_wiki_runs` the show, apply and reject actions and a
 * reason inside the ceiling, no new tool (full = 166,557, curated unchanged).
 * ORB-2818 added `orboto_lane_pause` and `orboto_lane_stop` to the full tier
 * inside the ceiling, curated unchanged (full = 168,165).
 * ORB-2819 added `orboto_lane_rereview` (+693, full tier only) inside the
 * ceiling: lane, ticket key and reason (full = 167,250, curated unchanged).
 * Its fix round added the lane-UUID sentence for a coordinator without
 * `admin:agent_lanes:read` to the tool and its lane parameter (full = 167,312
 * measured after the rebase onto ORB-2817, curated unchanged at 38,604).
 * Both together on develop: full = 168,920, 480 chars free under the ceiling.
 * ORB-2758 added `orboto_upload_link` to the full and curated tiers inside
 * both ceilings and the curated count: it took the curated seat of
 * `orboto_get_timer` (43 calls/30d), and the attachment tools gained the
 * stdio-only `filePath`, measured on the stdio build below. On top of
 * ORB-2818 and ORB-2819 it paid for itself without a new ceiling: the two
 * attachment tools lost their parameter texts for `contentBase64`, `filePath`
 * and `filename` (the name says it; the size bound sits in the one-sentence
 * summary), the shared handle text of the 16 truncation blocks lost 4 chars
 * (curated = 38,883, full = 169,379 over HTTP with 21 chars free, 169,326 on
 * the stdio build).
 * ORB-2834 added `orboto_git_probe` (full tier only) inside the ceiling: the
 * git_rotate_token title and its project key and connection id texts, the
 * project key texts of get_project, get_project_primer and project_readiness
 * (the first sentences say it), the wiki_runs first sentence (it keeps the
 * reject reason, the reason parameter says it too), the lane pause and lane
 * stop first sentences and reason text and the GitHub App installations one
 * shrank to pay for it, the pinned pause and stop phrases kept (full = 169,379
 * over HTTP, 21 chars free; curated = 38,836).
 * ORB-2837 added `orboto_browser_grants` (+680, full tier only) inside the
 * ceiling: the registration lists no `idempotentHint: false`, the MCP default
 * a client assumes anyway (56 tools, -1,288 chars, no hint lost; every other
 * hint stays as declared), so full = 168,794 over HTTP, 606 chars free;
 * curated = 38,583.
 * ORB-2843 added `orboto_space_manifest` (+574) and ORB-2850 gave
 * `orboto_embedding_status` three output fields (+207): each fit under the
 * ceiling alone, both together did not (develop 59c60d047: full = 169,637,
 * stdio = 169,584).
 * ORB-2871 won the headroom back without dropping a parameter, an enum value or
 * a bound: 87 titles, 57 first sentences (6 of them summary overrides in
 * tool-docs.ts) and 168 parameter texts (128 shortened, 40 dropped where the
 * name or the schema says it) lost what the name, the schema or the rest of the
 * description already says, and the space, parent doc and emoji texts became
 * shared constants (full = 164,487 from 169,637, stdio = 164,547 from 169,584,
 * curated = 37,683 from 38,583; 4,853 chars free under the full ceiling on the
 * larger stdio build).
 *
 * @see ORB-1805, ORB-1669, ORB-1910
 */
const CURATED_MAX_CHARS = 39_900;
const FULL_MAX_CHARS = 169_400;

/**
 * ORB-1805 - the estimator the ticket measured the failure with
 * (`n_keep: 13533 >= n_ctx: 8192` in LM Studio): characters / 3.6. It is
 * a rough tokenizer stand-in, deliberately the SAME rough number the
 * ticket, the docs page and these ceilings all use, so the figures a
 * reader compares are comparable. ORB-2791: the one estimator in
 * token-size.ts, which the stored doc sizes and every hit size share.
 */
const estTokens = tokensForChars;

/**
 * The minimal tier's whole connect cost - tool schemas AND the
 * instructions block - must fit a small local model's window with room
 * left for the conversation. 3,000 was the ticket's number; 3,100 since
 * ORB-1669 added the annotations block to every tool (+688 chars).
 */
const MINIMAL_MAX_TOKENS = 3_200;

/**
 * The curated tier is ratcheted on its TOOL SCHEMAS (the instructions
 * block has its own budget, enforced in instructions-budget.test.ts).
 */
const CURATED_SCHEMA_MAX_TOKENS = 11_100;

interface Measurement { count: number; chars: number; instructionsChars: number }

async function measuredManifest(toolset?: Toolset, localFiles = false): Promise<Measurement> {
  const server = await buildOrbotoMcpServer({
    baseUrl: 'https://orboto.example.com',
    apiKey: 'orb_test',
    ...(toolset ? { toolset } : {}),
    ...(localFiles ? { localFiles } : {}),
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

  it('ORB-2758 - the stdio build with filePath stays under the same ceilings', async () => {
    const curated = await measuredManifest(undefined, true);
    const full = await measuredManifest('full', true);
    process.stdout.write(`[manifest-size] stdio: curated ${curated.chars} chars, full ${full.chars} chars (~${estTokens(full.chars)} tokens)\n`);
    expect(curated.chars).toBeLessThanOrEqual(CURATED_MAX_CHARS);
    expect(full.chars).toBeLessThanOrEqual(FULL_MAX_CHARS);
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

/**
 * ORB-2210 - the `channel` tier registers no tool, so its whole per-turn
 * cost is the instructions block; 400 tokens is the ceiling the ticket set.
 */
const CHANNEL_MAX_TOKENS = 400;

async function channelInstructions(channel: boolean): Promise<{ tools: number; instructionsChars: number }> {
  const server = await buildOrbotoMcpServer({ baseUrl: 'https://orboto.example.com', apiKey: 'orb_test', toolset: 'channel', channel });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'manifest-measure', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const tools = client.getServerCapabilities()?.tools ? (await client.listTools()).tools.length : 0;
    return { tools, instructionsChars: (client.getInstructions() ?? '').length };
  } finally {
    await client.close();
    await server.close();
  }
}

describe('ORB-2210 - the channel manifest costs only its instructions', () => {
  it('channel: zero tools, instructions with the wake paragraph stay under 400 estimated tokens', async () => {
    const withWake = await channelInstructions(true);
    const bare = await channelInstructions(false);
    process.stdout.write(`[manifest-size] channel: ${withWake.tools} tools, instructions ${withWake.instructionsChars} chars (~${estTokens(withWake.instructionsChars)} tokens)\n`);
    expect(withWake.tools).toBe(0);
    expect(bare.tools).toBe(0);
    expect(estTokens(withWake.instructionsChars)).toBeLessThanOrEqual(CHANNEL_MAX_TOKENS);
    expect(bare.instructionsChars).toBeLessThan(withWake.instructionsChars);
  });
});
