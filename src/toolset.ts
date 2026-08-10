/**
 * ORB-1520 - manifest triage for the Code-Mode escape hatch (epic
 * ORB-1517).
 *
 * Eager-loading MCP clients (Codex, Cursor, Claude Desktop) pull EVERY
 * tool schema at connect time - with ~190 named tools that is tens of
 * thousands of tokens before the user says a word. The default manifest
 * is therefore the CURATED set below; the long tail stays fully
 * reachable through `orboto_api_search` + `orboto_api_call`, and the
 * complete named manifest is one opt-in away:
 *
 *   stdio: ORBOTO_MCP_TOOLSET=full
 *   http:  .../mcp?toolset=full  (or header x-orboto-toolset: full;
 *          the query param rides on every request, so no session
 *          persistence is involved)
 *
 * KEEP-LIST BASIS - measured, not guessed (ORB-1520): 30-day
 * `mcp_call_log` distribution on the core instance, 2026-08-10, 15.5k
 * calls total. Every tool with a meaningful call volume is in; the two
 * additions beyond the data are `orboto_my_tickets` (the natural "what
 * am I working on" entry for interactive desktop clients - the exact
 * audience this manifest serves; agent-dominated prod traffic
 * under-counts it) and the escape-hatch pair itself. The numbers live
 * in the ORB-1520 ticket comment.
 *
 * Tail tools are NOT deleted: their code, tests, chat mirrors and
 * drift-guard entries are untouched - only their REGISTRATION is
 * skipped in curated mode (the chat-tools parity guard reads server.ts
 * SOURCE, so it keeps covering the whole set in both modes).
 */

export type Toolset = 'curated' | 'full';

/** Order matches the measured 30d call counts (see ticket comment). */
export const CURATED_TOOLS: ReadonlySet<string> = new Set([
  // Session + identity + orientation
  'orboto_session_start',   // 662 calls/30d, and the binding-rules bootstrap
  'orboto_whoami',          // 28
  'orboto_get_project_primer', // 131
  'orboto_list_projects',   // 27, referenced by the server instructions
  // Reads
  'orboto_get_ticket',      // 1764
  'orboto_list_tickets',    // 161
  'orboto_my_tickets',      // interactive-client staple (see header)
  'orboto_search',          // 420
  'orboto_query',           // 26 - the OQL surface, prior art of this pattern
  'orboto_check_similar',   // 258 - mandated pre-create dup check
  'orboto_get_doc',         // 86
  // Ticket writes (the strict claim->commit->close loop)
  'orboto_create_ticket',   // 2069
  'orboto_update_ticket',   // 250
  'orboto_comment',         // 1838
  'orboto_claim',           // 1305
  'orboto_move_ticket',     // 1010
  'orboto_close_ticket',    // 889
  'orboto_set_parent',      // 44
  'orboto_add_ticket_dependency', // 314 - the mandated blocker primitive
  'orboto_check',           // 103 - acceptance-criteria checklists
  'orboto_create_milestone', // 42 - "milestone FIRST" rule for big features
  // Time tracking (the timer rules)
  'orboto_timer_start',     // 34
  'orboto_timer_stop',      // 772
  'orboto_log_time',        // 130
  'orboto_get_timer',       // 43
  // Transport plumbing + the escape hatch itself
  'orboto_response_expand', // ORB-1697 - the way back from a budget cut
  'orboto_api_search',      // ORB-1518 - discovery half of the escape hatch
  'orboto_api_call',        // ORB-1519 - execute half of the escape hatch
]);

/**
 * Resolve the effective toolset. `explicit` (per-connection: URL query /
 * header / BuildServerOptions) beats `envValue` (process-wide default);
 * anything unrecognized falls through, so a typo degrades to the safe
 * default instead of surprising with 190 tools.
 */
export function resolveToolset(
  explicit?: string | null,
  envValue?: string | null,
): Toolset {
  const parse = (v?: string | null): Toolset | null =>
    v === 'full' ? 'full' : v === 'curated' ? 'curated' : null;
  return parse(explicit) ?? parse(envValue) ?? 'curated';
}

/** Whether a tool registers under the given toolset. */
export function toolInToolset(toolName: string, toolset: Toolset): boolean {
  return toolset === 'full' || CURATED_TOOLS.has(toolName);
}
