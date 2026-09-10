/**
 * ORB-1520 - manifest triage for the Code-Mode escape hatch (epic
 * ORB-1517).
 *
 * @see ORB-1805
 */

export type Toolset = 'minimal' | 'curated' | 'full';

/**
 * ORB-1805 - the small-context tier.
 *
 * @see ORB-1471
 */
export const MINIMAL_TOOLS: ReadonlySet<string> = new Set([
  'orboto_session_start',
  'orboto_search',
  'orboto_get_ticket',
  'orboto_create_ticket',
  'orboto_update_ticket',
  'orboto_comment',
  'orboto_claim',
  'orboto_close_ticket',
  'orboto_timer_start',
  'orboto_timer_stop',
  'orboto_api_search',
  'orboto_api_call',
]);

/** Order matches the measured 30d call counts (see ticket comment). */
export const CURATED_TOOLS: ReadonlySet<string> = new Set([
  'orboto_session_start',   // 662 calls/30d, and the binding-rules bootstrap
  'orboto_whoami',          // 28
  'orboto_get_project_primer', // 131
  'orboto_list_projects',   // 27, referenced by the server instructions
  'orboto_get_ticket',      // 1764
  'orboto_list_tickets',    // 161
  'orboto_my_tickets',      // interactive-client staple (see header)
  'orboto_search',          // 420
  'orboto_query',           // 26 - the OQL surface, prior art of this pattern
  'orboto_check_similar',   // 258 - mandated pre-create dup check
  'orboto_get_doc',         // 86
  'orboto_create_ticket',   // 2069
  'orboto_bulk_create_tickets',   // ORB-1694 - 48 measured runs of consecutive creates
  'orboto_bulk_add_ticket_dependencies', // ORB-1694 - longest dependency run: 27 calls
  'orboto_update_ticket',   // 250
  'orboto_comment',         // 1838
  'orboto_claim',           // 1305
  'orboto_move_ticket',     // 1010
  'orboto_close_ticket',    // 889
  'orboto_set_parent',      // 44
  'orboto_add_ticket_dependency', // 314 - the mandated blocker primitive
  'orboto_check',           // 103 - acceptance-criteria checklists
  'orboto_create_milestone', // 42 - "milestone FIRST" rule for big features
  'orboto_timer_start',     // 34
  'orboto_timer_stop',      // 772
  'orboto_log_time',        // 130
  'orboto_get_timer',       // 43
  'orboto_messages',
  'orboto_agent_notify',
  'orboto_agent_broadcast',
  'orboto_agent_heartbeat',
  'orboto_response_expand',
  'orboto_report_feedback', // ORB-1910 - an agent that hits a bug reports it without ?toolset=full
  'orboto_help', // ORB-1697 - the way back from a budget cut
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
    v === 'full' ? 'full'
      : v === 'curated' ? 'curated'
        : v === 'minimal' ? 'minimal'
          : null;
  return parse(explicit) ?? parse(envValue) ?? 'curated';
}

/** Whether a tool registers under the given toolset. */
export function toolInToolset(toolName: string, toolset: Toolset): boolean {
  if (toolset === 'full') return true;
  if (toolset === 'minimal') return MINIMAL_TOOLS.has(toolName);
  return CURATED_TOOLS.has(toolName);
}
