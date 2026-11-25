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
    'Start a full backup job; poll it with orboto_list_backups.',
  orboto_get_ticket:
    'Fetch a ticket by key: fields, checklists, comments.',
  orboto_requirements_spec:
    'Requirements spec of a project or milestone from its tickets.',
  orboto_update_doc_space:
    'Update a doc space: name, description, icon, project, access.',
  orboto_search_docs:
    'Full-text doc/wiki search with snippets, by space or project.',
  orboto_critical_path:
    'Blocking dependency chain of a project or milestone.',
  /** ORB-2237 - shortened summaries that pay for `orboto_feedback_reply`; each tool's full text stays in `getToolDoc`. */
  orboto_agent_broadcast:
    'Message every agent in a workspace, project or topic scope.',
  orboto_api_search:
    'Find the REST endpoint for what no named tool covers.',
  orboto_get_doc:
    'A doc\'s Markdown content plus its backlinks.',
  orboto_primer_fact_list:
    'Structured project facts feeding the AI primer.',
  orboto_bulk_move_tickets:
    'Move every matching ticket to the same status category.',
  orboto_resolve_doc_smart_links:
    'Resolve doc, ticket, milestone and project smart links.',
  orboto_admin_translation_revert:
    'Restore the pre-translation title and description.',
  /** ORB-3078 - shortened summaries that pay for `orboto_credential_agent_access`; each tool's full text stays in `getToolDoc`. */
  orboto_browser_standing_allows:
    'List or revoke a browser session\'s standing allows.',
  orboto_admin_api_key_revoke:
    'Revoke an account\'s API key by id (admin:users:write).',
  orboto_delete_ticket:
    'DESTRUCTIVE, IRREVERSIBLE hard-delete of a ticket and its history.',
  orboto_lane_rereview:
    'Ask a review lane to review a ticket\'s delivery again.',
  orboto_browser_grants:
    'Lend your paired browser to an agent account you own; list, revoke.',
  orboto_wiki_plan_update:
    'Plan wiki page operations for an instruction WITHOUT writing.',
  orboto_session_digest:
    'What this session (or sessionId) did: tickets, commits, receipts, claims, mail.',
  orboto_set_raci:
    'Set a person\'s RACI role on a ticket.',
  orboto_primer_fact_supersede:
    'Replace a wrong fact by id; the old one stays in its history.',
  orboto_review_policy_check:
    'Read a ticket\'s review policy BEFORE spawning a review.',
  orboto_get_attachment:
    'Fetch an attachment\'s content by id.',
  orboto_admin_api_key_list:
    'Every API key: owner, prefix, use, expiry, flags (admin:audit:read).',
  orboto_list_ticket_statuses:
    'The project\'s workflow statuses, category and order.',
  orboto_get_audit_log:
    'Recent audit events: admin, role, deletion, federation.',
  orboto_primer_fact_history:
    'A fact and the versions it replaced, newest first.',
  orboto_wiki_ingest_url:
    'Fetch a public URL as Markdown into a SOURCE doc of the space.',
  /** ORB-3117 - shortened summaries that pay for `orboto_ai_reviewer`; each tool's full text stays in `getToolDoc`. */
  orboto_credential_agent_access:
    'Agents that may reveal a credential: entries, candidates, q by name or e-mail.',
  orboto_ci_status:
    'CI runs of a commit, branch, tag or PR.',
  orboto_ingest_file:
    'Upload a PDF, DOCX, Markdown or text file into `spaceId`.',
  orboto_update_company_closure:
    'Update a workspace-wide closure (offsite, shutdown).',
  orboto_reset_agent_instruction:
    'Restore a seeded rule block (builtinKey) to its shipped text.',
  orboto_close_milestone:
    'Close a milestone as completed or archived.',
  orboto_secret_exposures:
    'Secret guard incidents: masked preview, what to rotate.',
  orboto_upload_link:
    'Single-use upload link for a ticket or doc; give its URL to the person (50 MB, no login).',
  orboto_ingest_url:
    'Store a public URL as a Markdown doc in `spaceId`.',
  orboto_work_session_claims_add:
    'Add resource claims to your session; lease and timer stay.',
  orboto_wiki_save_answer:
    'Save an orboto_wiki_ask answer as a wiki page with citations.',
  orboto_unclaim:
    'Unassign yourself; the ticket goes back to `todo`.',
  orboto_primer_fact_add:
    'Record a project fact with evidence.',
  orboto_edit_doc:
    'Change a doc by exact string replacement; send only the diff.',
  orboto_project_readiness:
    'Setup checks before autonomous work, with fixes.',
  orboto_review_approval_record:
    'Record your review verdict against an orboto_review_fingerprint.',
  /** ORB-3147 - shorter summaries that keep the manifest clear of its ceiling; each tool's full text stays in `getToolDoc`. */
  orboto_import_cancel:
    'Cancel an import staging or a staged import.',
  orboto_wiki_ask:
    'Retrieval-augmented Q&A over the docs, or one space.',
  orboto_bulk_assign_tickets:
    'Add `assigneeEmail` to every ticket in `ticketKeys` or `query`.',
  orboto_wiki_apply_plan:
    'Commit an orboto_wiki_plan_update plan.',
  orboto_ask_docs:
    'Ask the wiki through the workspace RAG pipeline.',
  orboto_move_doc:
    'Reparent, reorder or move a doc into another space.',
  orboto_delete_doc_comment:
    'DESTRUCTIVE - deletes a doc comment and every reply under it.',
  orboto_work_sessions:
    'Visible work leases and spec tasks awaiting ticket replies.',
  orboto_admin_translation_list:
    'Tickets the AI auto-translate rewrote, newest first.',
  orboto_delete_doc_attachment:
    'DESTRUCTIVE - deletes a doc attachment and its stored file.',
  orboto_update_comment:
    'Edit a comment you wrote (super-admins: any).',
  orboto_work_session_claims_release:
    'Drop some or all resource claims; lease and timer stay.',
  orboto_agent_wakes:
    'Who woke this account\'s sessions and at what cost.',
  orboto_list_approvals:
    'A ticket\'s sign-off requests, the gates on transitions.',
  orboto_review_fingerprint:
    'Hash the exact submitted diff server-side.',
  orboto_list_backups:
    'Recent backup runs; download with orboto_download_backup.',
  orboto_bulk_patch_tickets:
    'PATCH many tickets (keys or query) at once.',
  orboto_list_agent_instructions:
    'ADMIN: rule BLOCKS at a scope for editing, not rules to follow.',
  orboto_set_milestone:
    'Move a ticket to another milestone, or off with null.',
  orboto_check_similar:
    'Duplicate check before orboto_create_ticket.',
  orboto_bulk_unassign_tickets:
    'Remove an assignee from many tickets.',
  orboto_work_session_start:
    'Take a ticket\'s work lease in a role and start its timer.',
  orboto_work_session_finish:
    'End a work session: timer booked, lease released, evidence kept.',
  orboto_admin_translation_approve:
    'Approve an auto-translated ticket.',
  orboto_bulk_comment_tickets:
    'Comment on every ticket in `ticketKeys` or `query`.',
  orboto_rule_proposal_accept:
    'Adopt a rule candidate or proposal, as proposed or edited.',
  orboto_list_docs_in_space:
    'A space\'s doc pages, flat; `parentDocId` rebuilds the tree.',
  orboto_raci:
    'A project\'s RACI matrix.',
  orboto_bulk_close_tickets:
    'Close every matching ticket.',
  orboto_remove_cross_project_link:
    'DESTRUCTIVE - drops a cross-project link between two tickets.',
  orboto_archive_project:
    'Archive a project: out of rotation, no data deleted.',
  orboto_list_doc_comments:
    'A doc\'s comments, oldest first, so replies read top-down.',
  orboto_list_cross_project_links:
    'A ticket\'s cross-project links, outgoing and incoming.',
  orboto_admin_agent_drift_list:
    'Agent drift events, newest first, with aggregate metrics.',
  orboto_list_ticket_attachments:
    'A ticket\'s attachments, newest first, with download URLs.',
  orboto_remove_ticket_dependency:
    'Drop the edge from `ticketKey` to `dependsOnKey`.',
  orboto_download_backup:
    'Download a backup run by id as a base64 resource.',
  orboto_api_call:
    'Escape hatch: one REST request to an endpoint without a named tool.',
  orboto_agent_heartbeat:
    'Register or refresh this agent\'s presence and status.',
  orboto_update_public_holiday:
    'Fix a public holiday\'s name or date; its id stays.',
  orboto_list_labels:
    'The project\'s label catalogue: `{id, name, color}`.',
  orboto_list_tickets:
    'A project\'s tickets by status, milestone or assignee.',
  orboto_query:
    'Tickets matching an OQL (or Jira-style JQL) query.',
  orboto_update_cross_project_link:
    'Toggle statusSyncEnabled on a cross-project link.',
  orboto_customer_report:
    'The customer-facing project report as Markdown.',
  orboto_portfolio_summary:
    'Portfolio / program-level cross-project rollup.',
  orboto_whoami:
    'The user of this server\'s API key.',
  orboto_personal_fact_list:
    'Your personal primer facts (AI preferences).',
  orboto_get_checklists:
    'A ticket\'s checklists with per-item completion.',
  orboto_response_expand:
    'Content a previous tool response omitted.',
  orboto_wiki_flag_stale:
    'Set or clear a page\'s "may be outdated" flag.',
  orboto_get_project:
    'A project with milestones, labels and members.',
  orboto_claim:
    'Assign yourself, move to in_progress, start a timer.',
  orboto_export_doc_pdf:
    'A doc as PDF, a base64 resource attachment.',
  orboto_list_doc_attachments:
    'A doc\'s attachments, newest first, with download URLs.',
  /** ORB-3188 - shorter wire summaries that buy the room of `orboto_design` (concept ORB-D205, 8.3); each full text stays in `getToolDoc`. */
  orboto_lane_stop:
    'Stop a lane now: interrupts the running turn, releases the work session; stays paused until resume.',
  orboto_lane_pause:
    'Pause a lane at its next turn boundary (work session is held) or resume it; orboto_lane_stop interrupts the running turn.',
  orboto_connector:
    'Connector links: source link, list, health, sync.',
  orboto_ci_log:
    'CI log of a job (jobId) or of a run\'s jobs (runId).',
  orboto_delete_doc_space:
    'DESTRUCTIVE - deletes the space and every doc in it.',
  orboto_list_git_app_installations:
    'GitHub App installations and their allowed projects.',
  orboto_list_ticket_dependencies:
    'A ticket\'s blockedBy and blocks dependencies.',
  orboto_ai_usage:
    'AI calls, tokens and errors over a date range.',
  orboto_rule_proposal_reject:
    'Dismiss a candidate or reject a proposal, with a reason.',
  orboto_message_work:
    'List, inspect or mutate durable message work.',
  orboto_knowledge_ask:
    'Ask the project and Operations wikis before a person; cite docs by key.',
  orboto_import_numbering:
    'A staged import\'s kept and renumbered numbers.',
  /** ORB-3206 - shorter summaries that pay for `from` and the dry-run sentence of `orboto_import_char_refs`; each tool's full text stays in `getToolDoc`. */
  orboto_knowledge_add:
    'File a durable fact in a project wiki (projectKey) or the Operations wiki, not just locally.',
  orboto_who:
    'Live agent sessions and their role addresses (integrator@KEY).',
  orboto_edit_doc_section:
    'Change a doc section by heading; send only that section.',
  /** ORB-3258 - shorter wire summaries that pay for `orboto_own_agents`; each tool's full text stays in `getToolDoc`. */
  orboto_search:
    'Search tickets, comments and docs; `types` adds more kinds.',
  orboto_work_next:
    'Reserve the next ready ticket of a project for a role.',
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
