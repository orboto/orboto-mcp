/**
 * ORB-1741 - the manifest diet (epic ORB-1691).
 *
 * @see ORB-1520
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
    'Start a full-workspace backup job; returns the job id to poll via orboto_list_backups.',
  orboto_get_ticket:
    'Fetch a ticket by key: fields, checklists, comments.',
  orboto_requirements_spec:
    'Generate a structured requirements spec for a project or milestone from its tickets.',
  orboto_update_doc_space:
    'Update a doc space\'s name, description, icon, project binding or access mode (open/restricted) by space id.',
  orboto_search_docs:
    'Full-text search over doc/wiki pages (query, optional space or project filter); returns matching pages with snippets.',
  orboto_critical_path:
    'Compute the critical path (blocking dependency chain) for a project or milestone.',
  /** ORB-2237 - shortened summaries that pay for `orboto_feedback_reply`; each tool's full text stays in `getToolDoc`. */
  orboto_agent_broadcast:
    'Fan-out a message to every agent in a workspace, project or topic scope.',
  orboto_api_search:
    'Discover REST API endpoints on demand - the escape hatch for any orboto endpoint.',
  orboto_get_doc:
    'Return a doc\'s content (Markdown) plus its backlinks.',
  orboto_primer_fact_list:
    'List structured project facts feeding the AI primer.',
  orboto_bulk_move_tickets:
    'Move every matching ticket to the same status category.',
  orboto_resolve_doc_smart_links:
    'Resolve doc/ticket/milestone/project smart-link references to their title + URL.',
  orboto_admin_translation_revert:
    'Restore the pre-translation title + description and clear the translation marker.',
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
