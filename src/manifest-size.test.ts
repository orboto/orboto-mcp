/**
 * ORB-1521 - manifest-size measurement + regression ratchet (epic
 * ORB-1517).
 */
import { readFileSync } from 'node:fs';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildOrbotoMcpServer } from './server.js';
import type { Toolset } from './toolset.js';
import { tokensForChars } from './token-size.js';
import { GUARDED_FILES, driftProblems, inconsistentTokenQuotes } from './test/toolset-quotes.js';

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
 * ORB-3013 added `orboto_ci_status`, `orboto_ci_log` and `orboto_ci_artifacts`
 * (full tier only) inside the ceiling: `repository` and a bare
 * `connectionId` pick the connection and their first sentences say what the
 * tool reads, not how (full = 169,348 on the stdio build, 52 chars free).
 * ORB-3078 added `orboto_credential_agent_access` (+730, full tier only)
 * inside the ceiling: its parameters carry no texts (the full description
 * behind orboto_help names them) and 16 summary overrides in tool-docs.ts pay
 * for it, each tool's full text kept (full = 169,386 on the stdio build, 14
 * chars free; curated = 37,919). The tool then became read-only (list and
 * candidates, a person edits the list): full = 169,287 on the stdio build,
 * 113 chars free; curated = 37,919.
 * ORB-3090 added `orboto_secret_exposures` (+1,130, full tier only) inside the
 * ceiling: the tool's parameters carry no texts and its first sentence is
 * short (the description behind orboto_help names the filters), and 33 texts
 * of other tools lost what the name, the schema or a sibling tool already
 * says (full = 169,282 over HTTP and 169,324 on the stdio build, 76 chars
 * free; before the diet 170,357 and 170,417; curated = 37,848).
 * ORB-3100 added `estimate` to orboto_create_ticket, orboto_update_ticket,
 * orboto_bulk_create_tickets and orboto_bulk_update_tickets inside the
 * ceiling: the server parses and bounds the text, so the parameters carry no
 * constraints, and the describes of `parentTicketKey` and
 * `duplicateJustification` went, the names say it (full = 169,344 over HTTP
 * and 169,386 on the stdio build, 14 chars free; curated = 37,881).
 * ORB-3101 added `noTime` to orboto_move_ticket, orboto_close_ticket,
 * orboto_bulk_move_tickets and orboto_bulk_close_tickets inside the ceiling:
 * the move title and the close, bulk-close, credential_agent_access, attach
 * and doc-attachment upload first sentences (both builds) shrank to pay for
 * it (full = 169,353 over HTTP and 169,393 on the stdio build, 7 chars free;
 * curated = 37,901).
 * ORB-3101 gave `orboto_work_finish` `noTime` inside the ceiling: only the
 * first sentence of a description reaches the manifest, so the outcome,
 * commitSha and targetCategory parameter describes shrank to pay for it
 * (full = 169,302 over HTTP and 169,342 on the stdio build, 58 chars free;
 * curated = 37,901).
 * ORB-3102 gave `orboto_timer_stop` and `orboto_get_timer` an optional
 * `ticketKey` and `orboto_list_time_entries` the source and agent time in its
 * answer inside the ceiling, no new tool: the first sentences stayed short
 * (the rest sits behind orboto_help), `ticketKey` of the stop lost its
 * `.min(3)` and a few time parameter texts shrank. Rebased onto the ORB-3101
 * ledger above, the `.min(3)` of the five time tools that carry a ticket key
 * went too (the API answers a malformed key with a 404): full = 169,266 over
 * HTTP and 169,306 on the stdio build, 94 chars free; curated = 37,878.
 * ORB-3121 added `orboto_import_stage`, `orboto_import_staging` and
 * `orboto_import_cancel` (+1,388, full tier only) inside the ceiling: their
 * parameters carry no texts and a read-only tool lists neither
 * `idempotentHint` nor `destructiveHint` (the MCP spec gives both meaning only
 * when `readOnlyHint` is false; 79 + 6 hints, -1,882 chars, every write hint
 * kept): full = 168,775 over HTTP and 168,815 on the stdio build, 585 chars
 * free; curated = 37,614. The cancel tool then learned the discard of a
 * staged import (+44 in its first sentence): 168,859 on the stdio build, 541
 * chars free.
 * ORB-3117 added `orboto_ai_reviewer` (+343, full tier only) inside the
 * ceiling: it declares no idempotentHint (a read-only tool), its first
 * sentence is short, and 16 new and 4 shorter summary overrides in
 * tool-docs.ts plus the docs visibility and move spaceId texts pay for it,
 * each tool's full text kept. Rebased onto ORB-3102: full = 169,283 over
 * HTTP and 169,323 on the stdio build, 77 chars free; curated = 37,862.
 * Rebased onto ORB-3121, its description naming the tie rule and the
 * unverified reason (summary unchanged): full = 168,836 over HTTP and
 * 168,876 on the stdio build, 524 chars free; curated = 37,598.
 * ORB-3147 added `orboto_admin_user_access` (full tier only) inside the
 * ceiling: the access email for up to 100 accounts and the reset link for
 * one, its parameters carry no texts or string bounds (the API bounds them),
 * it declares destructiveHint true (it mails people and deletes their older
 * unused access links, so a client confirms it), and the upload link title
 * shrank: full = 169,357 over HTTP and 169,397 on the stdio build, 3 chars
 * free; curated = 37,590. It then bought room back: 71 wire summaries in
 * tool-docs.ts say the same facts in fewer words (each full text stays in
 * `getToolDoc`), three more titles shortened, and the 16 output schemas no
 * longer repeat what the truncation handle is for, which
 * orboto_response_expand's `handle` parameter and every truncated response
 * say: full = 167,811 over HTTP and 167,851 on the stdio build, 1,549 chars
 * free; curated = 37,049.
 * ORB-3174 bounded the heartbeat's clientInfo texts and capabilities and made
 * them and the resource claim values one printable line inside the ceiling:
 * the printable check is a refinement, so no tool carries a pattern, only a
 * maxLength: 169,156 on the stdio build, 244 chars free; curated = 37,374.
 * ORB-3188 added `orboto_design` (full tier only, DESIGN_TOOL_MAX_CHARS) inside
 * the ceiling: one action enum, a handle and a payload object in the shape of
 * `orboto_connector`, its first sentence on the wire, and 11 new and 16 shorter
 * summary overrides in tool-docs.ts (concept ORB-D205, 8.3) pay for it, each
 * tool's full text kept and every pinned wire text unchanged. The overrides
 * alone: 168,716 on the stdio build (440 bought); with the tool (605 on the
 * wire) and the ticket create `buildsFrom` parameter (+31, no text): full =
 * 169,313 over HTTP and 169,353 on the stdio build, 47 chars free; curated =
 * 37,405. The review fix of ORB-3188 left the action enum at get until A2 and
 * A3 and named what they add: the tool is 530 on the wire, full = 169,238 over
 * HTTP and 169,278 on the stdio build, 122 chars free. The next tool or
 * parameter buys its own room.
 * ORB-3206 added `orboto_import_char_refs` (full tier only, 455 on the wire:
 * a plain string token, `apply` and no `from`, the handler runs every batch)
 * inside the ceiling: 25 titles name the same action in fewer words, the
 * primer fact add summary shrank and orboto_knowledge_ask got a shorter
 * override in tool-docs.ts, each full text kept; the lane, upload link and
 * attachment summaries stay, their tests pin them: full = 169,317 over HTTP
 * and 169,357 on the stdio build, 43 chars free; curated = 37,388. Its fix
 * round brought back the qualifier of eight titles (ticket untouched,
 * start/renew, pending/draft, the wiki URL source and ingest pair,
 * close/archive, resolve/reopen, flag/clear) and gave the tool a project key
 * and a resume point: `apply` is the position the repair starts at (no
 * separate `from`), its wire sentence shrank to "Fix an import's k&#252;rzer."
 * (427 on the wire): full = 169,360 over HTTP and 169,400 on the stdio
 * build, 0 chars free. Its second fix round split that position off again:
 * `apply` is a boolean, `from` an integer of 0 or more, and the wire sentence
 * says a call without apply is a dry run (507 on the wire); seven summaries
 * paid for it (api_search, company closure, project readiness, knowledge
 * ask, knowledge add, who, edit doc section): full = 169,358 over HTTP and
 * 169,398 on the stdio build, 2 chars free.
 * ORB-3257 gave `orboto_list_users` the `sort` and `order` enums of
 * `GET /admin/users` inside the ceiling: its search and showGhosts
 * parameters lost their texts and limit its schema default (the full
 * description behind orboto_help says all three, the handler still sends
 * 50), and its first sentence shrank to "All workspace users.": full =
 * 169,352 over HTTP and 169,392 on the stdio build, 8 chars free; curated
 * unchanged at 37,369.
 * ORB-3258 added `orboto_own_agents` (full tier only, one tool with list,
 * create and deactivate actions instead of three named tools, 532 on the
 * wire): 24 wire summaries in tool-docs.ts SUMMARY_OVERRIDES name the same
 * action in fewer words, each full text kept in getToolDoc: full = 169,331
 * over HTTP and 169,371 on the stdio build, 29 chars free; curated = 37,323.
 * Both together on develop: full = 169,325 over HTTP and 169,365 on the
 * stdio build, 35 chars free; curated = 37,323.
 *
 * @see ORB-1805, ORB-1669, ORB-1910
 */
const CURATED_MAX_CHARS = 39_900;
const FULL_MAX_CHARS = 169_400;
/** ORB-3188 - the wire size of `orboto_design` (concept ORB-D205, 8.3: measured 530 with the get-only enum, budget 545). */
const DESIGN_TOOL_MAX_CHARS = 545;

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

interface Measurement { count: number; chars: number; instructionsChars: number; tools: Array<{ name: string }> }

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
    const tools: Array<{ name: string }> = [];
    do {
      const page = await client.listTools(cursor ? { cursor } : {});
      tools.push(...page.tools);
      cursor = page.nextCursor;
    } while (cursor);
    const instructions = String(
      (server as unknown as { server: { _instructions?: string } }).server._instructions ?? '',
    );
    return { count: tools.length, chars: JSON.stringify(tools).length, instructionsChars: instructions.length, tools };
  } finally {
    await client.close();
    await server.close();
  }
}

describe('ORB-1521 - eager-load manifest size', () => {
  it('curated manifest stays under the ratchet ceiling', async () => {
    const { count, chars } = await measuredManifest();
    console.log(`[manifest-size] curated: ${count} tools, ${chars} chars (~${estTokens(chars)} tokens)`);
    expect(count).toBeLessThanOrEqual(36);
    expect(chars).toBeLessThanOrEqual(CURATED_MAX_CHARS);
    expect(estTokens(chars)).toBeLessThanOrEqual(CURATED_SCHEMA_MAX_TOKENS);
  });

  it('full manifest remains available and an order of magnitude larger', async () => {
    const curated = await measuredManifest();
    const full = await measuredManifest('full');
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

  it('ORB-3188 - orboto_design stays within its own budget on the wire, in the full tier only', async () => {
    const full = await measuredManifest('full');
    const curated = await measuredManifest();
    const design = full.tools.find((t) => t.name === 'orboto_design');
    process.stdout.write(`[manifest-size] orboto_design: ${JSON.stringify(design).length} chars; full over HTTP ${full.chars} chars\n`);
    expect(design).toBeDefined();
    expect(JSON.stringify(design).length).toBeLessThanOrEqual(DESIGN_TOOL_MAX_CHARS);
    expect(curated.tools.some((t) => t.name === 'orboto_design')).toBe(false);
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

/**
 * ORB-2873 - the tool counts, token figures and character counts the docs, the READMEs, the skill reference and the Go cost table
 * quote follow the measurement above; GUARDED_FILES lists every file that carries one.
 */
describe('ORB-2873 - quoted toolset figures follow the measurement', () => {
  it('every quoted tool count is the measured one, every token and character figure is within 5 % of it, and no figure is unmarked', async () => {
    const [channel, minimal, curated, full] = [await channelInstructions(true), await measuredManifest('minimal'), await measuredManifest(), await measuredManifest('full')];
    const measured = {
      channel: { tools: channel.tools, tokens: estTokens(channel.instructionsChars), chars: channel.instructionsChars },
      minimal: { tools: minimal.count, tokens: estTokens(minimal.chars + minimal.instructionsChars), chars: minimal.chars },
      curated: { tools: curated.count, tokens: estTokens(curated.chars), chars: curated.chars },
      full: { tools: full.count, tokens: estTokens(full.chars), chars: full.chars },
    };
    const read = (file: string) => readFileSync(new URL(`../../../${file}`, import.meta.url), 'utf8');
    expect(driftProblems(GUARDED_FILES, read, measured), 'update each marked quote to the measured figure in the same commit as the tool change').toEqual([]);
  });

  it('every file quotes the same token figure for a toolset (ORB-3258)', () => {
    const read = (file: string) => readFileSync(new URL(`../../../${file}`, import.meta.url), 'utf8');
    expect(inconsistentTokenQuotes(GUARDED_FILES, read), 'quote one rounded measurement everywhere').toEqual([]);
  });
});
