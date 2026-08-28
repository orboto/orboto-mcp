/**
 * ORB-1741 - the manifest diet (epic ORB-1691).
 *
 * Every tool description in the manifest is STANDING context cost: an
 * eager-loading client pays it on connect, every session. The curated
 * toolset (ORB-1520) cut the tool COUNT; this module cuts the per-tool
 * TEXT. At registration time (with-metrics.ts) the full description is
 * captured here and the wire manifest carries only a one-sentence
 * summary; `orboto_help { tool }` serves the full guidance lazily - the
 * same deferred-docs pattern ToolSearch uses for deferred tools.
 *
 * The full texts stay where they always lived - in each tool file's
 * `description` - so authors keep writing complete guidance and nothing
 * is lost: the summary is DERIVED (first sentence, or a hand-written
 * override for the few whose first sentence overruns the cap).
 */

/** Soft cap for a wire description; the ratchet in manifest-size.test.ts
 *  enforces the aggregate outcome. */
export const SUMMARY_MAX_CHARS = 220;

/**
 * Hand-written one-liners for tools whose first sentence exceeds the cap
 * (measured 2026-08-28: 6 of 172). Keep each under SUMMARY_MAX_CHARS and
 * name the key inputs.
 */
const SUMMARY_OVERRIDES: Record<string, string> = {
  orboto_create_full_backup:
    'Start a full-workspace backup job (all projects, users, config, attachments); returns the job id to poll via orboto_list_backups.',
  orboto_get_ticket:
    'Fetch one ticket by key (ORB-42) or UUID: full detail incl. description, status, assignees, checklists, dependencies and comments.',
  orboto_requirements_spec:
    'Generate a structured requirements spec for a project or milestone from its tickets (scope, actors, functional + non-functional requirements).',
  orboto_update_doc_space:
    'Update a doc space\'s name, description, icon, project binding or access mode (open/restricted) by space id.',
  orboto_search_docs:
    'Full-text search over doc/wiki pages (query, optional space or project filter); returns matching pages with snippets.',
  orboto_critical_path:
    'Compute the dependency-based critical path for a project or milestone: the blocking chain of tickets that determines the earliest finish.',
};

/** Runtime registry: tool name -> full guidance text, captured at
 *  registration. Module-global on purpose - the HTTP transport builds one
 *  server per session but the docs are identical, so re-capture is an
 *  idempotent Map.set. */
const toolDocs = new Map<string, string>();

export function captureToolDoc(toolName: string, fullDescription: string): void {
  toolDocs.set(toolName, fullDescription);
}

export function getToolDoc(toolName: string): string | undefined {
  return toolDocs.get(toolName);
}

export function listToolDocNames(): string[] {
  return [...toolDocs.keys()].sort();
}

/**
 * One-sentence wire summary: the override when one exists, else the
 * first sentence (sentence-end followed by whitespace/EOL). A first
 * sentence still over the cap falls back to a word-boundary cut - the
 * summary must never silently exceed what the ratchet budgets for.
 */
export function summarizeToolDescription(toolName: string, full: string): string {
  const override = SUMMARY_OVERRIDES[toolName];
  if (override) return override;
  const match = full.match(/^[\s\S]*?[.!?](?=\s|$)/);
  let first = (match ? match[0] : full).trim();
  if (first.length > SUMMARY_MAX_CHARS) {
    const cut = first.slice(0, SUMMARY_MAX_CHARS - 3);
    first = `${cut.slice(0, cut.lastIndexOf(' '))}...`;
  }
  return first;
}
