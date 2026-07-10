/**
 * ORB-244 Phase A/B — MCP server factory.
 *
 * Builds an `McpServer` with the registered tool set + a handle to
 * the orboto REST client. Transport is picked by the process entry
 * point (`index.ts`) based on `ORBOTO_MCP_TRANSPORT=stdio|http`.
 *
 * Keeping the server factory transport-agnostic means `server.ts` is
 * the same object whether we ship stdio for Local-Proxy (Phase G
 * `@orboto/mcp-cli`) or HTTP-SSE for Self-Hosted-inline.
 *
 * Tool registrations stay in this file so adding a new tool in
 * Phase C is one diff here + one new file in `tools/`. Phase D will
 * add `registerResource` / `registerPrompt` calls here too.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { VERSION } from './version.js';
import { SubscribeRequestSchema, UnsubscribeRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { OrbotoClient, type OrbotoClientConfig } from './orboto-client.js';
import { registerOrbotoResources } from './resources.js';
import { registerOrbotoPrompts } from './prompts.js';
import { registerWithMetrics } from './with-metrics.js';
import { createNudgeState } from './session-nudge.js';
import { aiStatusToolConfig, makeAiStatusHandler } from './tools/ai-status.js';
import { embeddingStatusToolConfig, makeEmbeddingStatusHandler } from './tools/embedding-status.js';
import { aiUsageToolConfig, makeAiUsageHandler } from './tools/ai-usage.js';
import { sessionStartToolConfig, makeSessionStartHandler } from './tools/session-start.js';
import {
  listAgentInstructionsToolConfig, makeListAgentInstructionsHandler,
  createAgentInstructionToolConfig, makeCreateAgentInstructionHandler,
  updateAgentInstructionToolConfig, makeUpdateAgentInstructionHandler,
  resetAgentInstructionToolConfig, makeResetAgentInstructionHandler,
  deleteAgentInstructionToolConfig, makeDeleteAgentInstructionHandler,
} from './tools/agent-instructions.js';
import {
  agentHeartbeatToolConfig, makeAgentHeartbeatHandler,
  agentPresenceToolConfig, makeAgentPresenceHandler,
  agentNotifyToolConfig, makeAgentNotifyHandler,
  agentBroadcastToolConfig, makeAgentBroadcastHandler,
} from './tools/agent-coordination.js';
import { listProjectsToolConfig, makeListProjectsHandler } from './tools/list-projects.js';
import { getProjectToolConfig, makeGetProjectHandler } from './tools/get-project.js';
import { getProjectPrimerToolConfig, makeGetProjectPrimerHandler } from './tools/get-project-primer.js';
import { listTicketsToolConfig, makeListTicketsHandler } from './tools/list-tickets.js';
import { criticalPathToolConfig, makeCriticalPathHandler } from './tools/critical-path.js';
import { analyticsToolConfig, makeAnalyticsHandler } from './tools/analytics.js';
import { raciToolConfig, makeRaciHandler, setRaciToolConfig, makeSetRaciHandler } from './tools/raci.js';
import { getTicketToolConfig, makeGetTicketHandler } from './tools/get-ticket.js';
import { myTicketsToolConfig, makeMyTicketsHandler } from './tools/my-tickets.js';
import {
  listMilestonesToolConfig, makeListMilestonesHandler,
  getMilestoneToolConfig, makeGetMilestoneHandler,
} from './tools/milestones.js';
import { searchToolConfig, makeSearchHandler } from './tools/search.js';
import { queryToolConfig, makeQueryHandler } from './tools/query.js';
import { customerReportToolConfig, makeCustomerReportHandler } from './tools/customer-report.js';
import { requirementsSpecToolConfig, makeRequirementsSpecHandler } from './tools/requirements-spec.js';
import {
  wikiIngestUrlToolConfig, makeWikiIngestUrlHandler,
  wikiAskToolConfig, makeWikiAskHandler,
  wikiLintToolConfig, makeWikiLintHandler,
  wikiPlanUpdateToolConfig, makeWikiPlanUpdateHandler,
  wikiApplyPlanToolConfig, makeWikiApplyPlanHandler,
  wikiRecordToolConfig, makeWikiRecordHandler,
  wikiAppendSectionToolConfig, makeWikiAppendSectionHandler,
  wikiFlagStaleToolConfig, makeWikiFlagStaleHandler,
  wikiSaveAnswerToolConfig, makeWikiSaveAnswerHandler,
} from './tools/wiki.js';
import {
  personalFactListToolConfig, makePersonalFactListHandler,
  personalFactAddToolConfig, makePersonalFactAddHandler,
  personalFactUpdateToolConfig, makePersonalFactUpdateHandler,
  personalFactDeleteToolConfig, makePersonalFactDeleteHandler,
} from './tools/personal-facts.js';
import {
  listDocSpacesToolConfig, makeListDocSpacesHandler,
  getDocToolConfig, makeGetDocHandler,
  createDocSpaceToolConfig, makeCreateDocSpaceHandler,
  updateDocSpaceToolConfig, makeUpdateDocSpaceHandler,
  deleteDocSpaceToolConfig, makeDeleteDocSpaceHandler,
  listDocsInSpaceToolConfig, makeListDocsInSpaceHandler,
  createDocToolConfig, makeCreateDocHandler,
  updateDocToolConfig, makeUpdateDocHandler,
  deleteDocToolConfig, makeDeleteDocHandler,
  moveDocToolConfig, makeMoveDocHandler,
  duplicateDocSpaceToolConfig, makeDuplicateDocSpaceHandler,
  resolveDocSmartLinksToolConfig, makeResolveDocSmartLinksHandler,
} from './tools/docs.js';
import {
  searchDocsToolConfig, makeSearchDocsHandler,
  editDocToolConfig, makeEditDocHandler,
  editDocSectionToolConfig, makeEditDocSectionHandler,
} from './tools/doc-edits.js';
import {
  uploadDocAttachmentToolConfig, makeUploadDocAttachmentHandler,
  listDocAttachmentsToolConfig, makeListDocAttachmentsHandler,
  deleteDocAttachmentToolConfig, makeDeleteDocAttachmentHandler,
} from './tools/doc-attachments.js';
import {
  listTicketAttachmentsToolConfig, makeListTicketAttachmentsHandler,
  getAttachmentToolConfig, makeGetAttachmentHandler,
} from './tools/ticket-attachments.js';
import {
  exportDocMdToolConfig, makeExportDocMdHandler,
  exportDocPdfToolConfig, makeExportDocPdfHandler,
} from './tools/doc-export.js';
import {
  listDocRevisionsToolConfig, makeListDocRevisionsHandler,
  getDocRevisionToolConfig, makeGetDocRevisionHandler,
  restoreDocRevisionToolConfig, makeRestoreDocRevisionHandler,
} from './tools/doc-revisions.js';
import {
  listDocCommentsToolConfig, makeListDocCommentsHandler,
  postDocCommentToolConfig, makePostDocCommentHandler,
  resolveDocCommentToolConfig, makeResolveDocCommentHandler,
  updateDocCommentToolConfig, makeUpdateDocCommentHandler,
  deleteDocCommentToolConfig, makeDeleteDocCommentHandler,
} from './tools/doc-comments.js';
import {
  updatePublicHolidayToolConfig, makeUpdatePublicHolidayHandler,
  updateCompanyClosureToolConfig, makeUpdateCompanyClosureHandler,
  updateAbsenceToolConfig, makeUpdateAbsenceHandler,
} from './tools/absence-writes.js';
import {
  listCrossProjectLinksToolConfig, makeListCrossProjectLinksHandler,
  addCrossProjectLinkToolConfig, makeAddCrossProjectLinkHandler,
  updateCrossProjectLinkToolConfig, makeUpdateCrossProjectLinkHandler,
  removeCrossProjectLinkToolConfig, makeRemoveCrossProjectLinkHandler,
} from './tools/cross-project-links.ee.js';
import { getTimerToolConfig, makeGetTimerHandler } from './tools/get-timer.js';
import { getChecklistsToolConfig, makeGetChecklistsHandler } from './tools/get-checklists.js';
import { listGitAppInstallationsToolConfig, makeListGitAppInstallationsHandler } from './tools/list-git-app-installations.js';
import {
  createTicketToolConfig, makeCreateTicketHandler,
  updateTicketToolConfig, makeUpdateTicketHandler,
  moveTicketToolConfig, makeMoveTicketHandler,
  closeTicketToolConfig, makeCloseTicketHandler,
  deleteTicketToolConfig, makeDeleteTicketHandler,
  commentToolConfig, makeCommentHandler,
  updateCommentToolConfig, makeUpdateCommentHandler,
  deleteCommentToolConfig, makeDeleteCommentHandler,
  assignToolConfig, makeAssignHandler,
  unassignToolConfig, makeUnassignHandler,
  labelTicketToolConfig, makeLabelTicketHandler,
  unlabelTicketToolConfig, makeUnlabelTicketHandler,
  setMilestoneToolConfig, makeSetMilestoneHandler,
  addTicketDependencyToolConfig, makeAddTicketDependencyHandler,
  removeTicketDependencyToolConfig, makeRemoveTicketDependencyHandler,
  listTicketDependenciesToolConfig, makeListTicketDependenciesHandler,
} from './tools/ticket-writes.js';
import {
  timerStartToolConfig, makeTimerStartHandler,
  timerStopToolConfig, makeTimerStopHandler,
  logTimeToolConfig, makeLogTimeHandler,
  listTimeEntriesToolConfig, makeListTimeEntriesHandler,
  editTimeEntryToolConfig, makeEditTimeEntryHandler,
  deleteTimeEntryToolConfig, makeDeleteTimeEntryHandler,
} from './tools/time-writes.js';
import {
  checkToolConfig, makeCheckHandler,
  uncheckToolConfig, makeUncheckHandler,
  addCheckToolConfig, makeAddCheckHandler,
  removeCheckToolConfig, makeRemoveCheckHandler,
  newChecklistToolConfig, makeNewChecklistHandler,
} from './tools/checklist-writes.js';
import {
  listUsersToolConfig, makeListUsersHandler,
  getAuditLogToolConfig, makeGetAuditLogHandler,
  triggerBackupToolConfig, makeTriggerBackupHandler,
} from './tools/admin-writes.js';
import {
  createFullBackupToolConfig, makeCreateFullBackupHandler,
  listBackupsToolConfig, makeListBackupsHandler,
  downloadBackupToolConfig, makeDownloadBackupHandler,
} from './tools/backup.js';
import {
  primerFactListToolConfig, makePrimerFactListHandler,
  primerFactAddToolConfig, makePrimerFactAddHandler,
  primerFactUpdateToolConfig, makePrimerFactUpdateHandler,
  primerFactSupersedeToolConfig, makePrimerFactSupersedeHandler,
  primerFactVerifyToolConfig, makePrimerFactVerifyHandler,
  primerFactDeleteToolConfig, makePrimerFactDeleteHandler,
} from './tools/primer-facts.js';

// ORB-799 — wrapper-feature-parity gap-close.
import { whoamiToolConfig, makeWhoamiHandler } from './tools/identity.js';
import {
  claimToolConfig, makeClaimHandler,
  unclaimToolConfig, makeUnclaimHandler,
} from './tools/claim.js';
import {
  listApprovalsToolConfig, makeListApprovalsHandler,
  approvalDecideToolConfig, makeApprovalDecideHandler,
} from './tools/approvals.js';
import {
  createMilestoneToolConfig, makeCreateMilestoneHandler,
  closeMilestoneToolConfig, makeCloseMilestoneHandler,
  updateMilestoneToolConfig, makeUpdateMilestoneHandler,
} from './tools/milestones.js';
import {
  listTicketStatusesToolConfig, makeListTicketStatusesHandler,
  listLabelsToolConfig, makeListLabelsHandler,
  createLabelToolConfig, makeCreateLabelHandler,
} from './tools/project-listings.js';
import {
  bulkPatchTicketsToolConfig, makeBulkPatchTicketsHandler,
  bulkMoveTicketsToolConfig, makeBulkMoveTicketsHandler,
  bulkCloseTicketsToolConfig, makeBulkCloseTicketsHandler,
  bulkCommentTicketsToolConfig, makeBulkCommentTicketsHandler,
  bulkAssignTicketsToolConfig, makeBulkAssignTicketsHandler,
  bulkUnassignTicketsToolConfig, makeBulkUnassignTicketsHandler,
} from './tools/bulk-writes.js';
import {
  askDocsToolConfig, makeAskDocsHandler,
  ingestUrlToolConfig, makeIngestUrlHandler,
  ingestFileToolConfig, makeIngestFileHandler,
} from './tools/docs-ai.js';
import { attachToTicketToolConfig, makeAttachToTicketHandler } from './tools/attach.js';
import { setParentToolConfig, makeSetParentHandler } from './tools/set-parent.js';
import {
  updateProjectToolConfig, makeUpdateProjectHandler,
  createProjectToolConfig, makeCreateProjectHandler,
  archiveProjectToolConfig, makeArchiveProjectHandler,
} from './tools/update-project.js';
import { checkSimilarToolConfig, makeCheckSimilarHandler } from './tools/check-similar.js';
import {
  listAdminTranslationsToolConfig, makeListAdminTranslationsHandler,
  approveTranslationToolConfig, makeApproveTranslationHandler,
  revertTranslationToolConfig, makeAdminRevertTranslationHandler,
} from './tools/admin-translations.js';
import {
  listAgentDriftToolConfig, makeListAgentDriftHandler,
  resolveAgentDriftToolConfig, makeResolveAgentDriftHandler,
} from './tools/agent-drift.js';

export interface BuildServerOptions extends OrbotoClientConfig {
  /** Optional — passed through to McpServer metadata. Clients
   *  sometimes surface this in their UI. */
  clientDescription?: string;
  /** ORB-940 — when present, the server registers
   *  resources/subscribe + resources/unsubscribe handlers that
   *  write into this set. The HTTP transport reads from it to
   *  decide which events to push through. Stdio sessions can pass
   *  their own set if they want live updates; without one, the
   *  resources/subscribe capability stays advertised but no events
   *  ever fire (which is correct — a stdio client without a
   *  bridge wouldn't receive them anyway). */
  subscriptions?: Set<string>;
}

/** ORB-1090 — the workspace's configurable working-rules, used as the
 *  fallback when the live fetch fails (offline / pre-1086 instance).
 *  On success these are replaced by the live assembled blocks so admin
 *  edits propagate to every new MCP connection. */
const FALLBACK_WORKING_RULES = [
  'The following are BINDING operating rules, not guidelines — follow every one exactly, on every action, without being reminded; skipping, deferring, or "interpreting" them means the task is not done.',
  'Workflow is STRICT: claim -> commit -> close, one ticket = one commit, every time (not only when reminded). Before touching code, claim an existing ticket or create one (`orboto_claim` / `orboto_create_ticket`) — never do silent, unticketed work. When the task is done make exactly ONE commit (with the ticket key in the subject), push it, then move the ticket to in_review/done with a one-line summary (`orboto_move_ticket` + `orboto_comment`). Do not leave finished work uncommitted.',
  'When you write a git commit that touches a ticket, put the ticket key (e.g. `ORB-42`) in parentheses at the END of the subject line — `feat(auth): add token rotation (ORB-42)`. The orboto git-activity parser links the commit by that key.',
  'Use sub-tickets for steps large enough to need their own commit / time tracking / review, and checklists for one-liners inside a single ticket\'s scope. Big features (Epic + 3+ phase tickets): create a milestone FIRST, then the Epic, then phase tickets as children on that milestone.',
].join(' ');

// Static MCP operational hints — tool/resource/prompt usage that does
// not change per workspace. The configurable working-rules are appended
// live below.
const STATIC_MCP_HINTS = [
  'orboto is a ticket + project management system.',
  'When starting on a project, call `orboto_get_project_primer(<PROJECT_KEY>)` once to load its conventions (tech stack, commands, gotchas, expected ticket language).',
  'Use `orboto_list_projects` first to discover what the user can see.',
  'Ticket keys look like `PROJ-123`; the first segment is the project key.',
  'For "what am I working on?" prefer `orboto_my_tickets`; for "anything about X?" prefer `orboto_search`.',
  'Checklists: `orboto_get_ticket` includes them inline; use `orboto_get_checklists` when you only need the items. A linked-ticket suffix (`↪ [ACME-99]`) means the item is automatically checked/unchecked as that ticket\'s status moves.',
  'Resources (`orboto://rules`, `orboto://ticket/<key>`, `orboto://doc/<id>`, `orboto://project/<key>`, `orboto://search/<query>`) return read-only Markdown. The `orboto://` URI scheme stays canonical. `orboto://rules` returns the COMPLETE binding rules cap-independently (this instructions block may be truncated by the client). Prompts (`plan-sprint`, `triage-my-tickets`, `summarize-project`, `estimate-ticket`, `find-duplicates`) are one-click guided workflows.',
  'All writes respect the caller\'s project-level permissions — a 403 means the API rejected the write, not the MCP server.',
].join(' ');

// ORB-1177 — MCP clients cap how much of the `instructions` block they
// inject and silently truncate the overflow (ORB-1168 saw a 5k+ string
// cut mid-rule). Enforce our own budget so the high-priority head (hints
// + non-negotiables + the orboto_session_start / orboto://rules pointers)
// always survives, and the workspace rules are cut at a WHOLE-LINE
// boundary with an explicit pointer to the cap-independent full set,
// rather than the client slicing mid-sentence. The complete rules are
// always available via orboto_session_start + the orboto://rules resource.
const INSTRUCTIONS_BUDGET = 4000;
const RULES_HEADING = 'Working rules for this workspace:\n';
const TRUNCATION_MARKER =
  '\n\n[... rules truncated to fit the client cap — read the COMPLETE rules via the orboto_session_start tool or the orboto://rules resource ...]';

export function assembleInstructions(head: string, workingRules: string, budget = INSTRUCTIONS_BUDGET): string {
  const full = `${head}\n\n${RULES_HEADING}${workingRules}`;
  if (full.length <= budget) return full;
  const room = budget - head.length - RULES_HEADING.length - TRUNCATION_MARKER.length - 2; // 2 = the '\n\n' join
  let kept = '';
  if (room > 0) {
    for (const line of workingRules.split('\n')) {
      if (kept.length + line.length + 1 > room) break;
      kept += (kept ? '\n' : '') + line;
    }
  }
  return `${head}\n\n${RULES_HEADING}${kept}${TRUNCATION_MARKER}`;
}

export async function buildOrbotoMcpServer(opts: BuildServerOptions): Promise<McpServer> {
  const client = new OrbotoClient(opts);

  // ORB-1090 — fetch the workspace's configurable working-rules at
  // connect so admin edits propagate to every new MCP session. The
  // instructions block is the one place every MCP client reliably sees
  // the rules (clients don't read the repo's CLAUDE.md). Best-effort:
  // fall back to the built-in rules if the instance predates ORB-1086
  // or the fetch fails.
  let workingRules = FALLBACK_WORKING_RULES;
  try {
    const res = await client.get<{ instructions: string }>('/agent-instructions');
    if (res?.instructions?.trim()) workingRules = res.instructions.trim();
  } catch {
    // keep the fallback
  }

  const server = new McpServer(
    { name: 'orboto', version: VERSION },
    {
      // ORB-940 — advertise resources/subscribe so MCP-aware clients
      // (Claude Desktop, Cursor) wire up live updates instead of
      // polling. Even when no bridge is hooked up (stdio sessions)
      // the capability stays on; subscriptions just stay quiet.
      capabilities: {
        resources: { subscribe: true, listChanged: true },
      },
      // `instructions` appears in the system-prompt-style block some
      // MCP clients inject before the user's first message. Static
      // operational hints + the live, workspace-configurable working
      // rules (ORB-1086).
      //
      // ORB-1168 — MCP clients cap how much of this block they inject; a
      // 5k+ string was being silently truncated mid-rule, so an MCP-only
      // agent (no skill / no repo CLAUDE.md) got incomplete rules. Put
      // the orientation, a pointer to the full rule set (the
      // orboto_session_start tool), and the core non-negotiables
      // FIRST so they survive any truncation; the full workspace rules
      // follow and only their tail is at risk.
      instructions: assembleInstructions(
        [
          STATIC_MCP_HINTS,
          'FIRST ACTION this session: call the `orboto_session_start` tool — it returns the complete, authoritative binding rules you must follow (plus your in-progress work). Re-run it after any context compaction. If the rules below look cut off, `orboto_session_start` and the `orboto://rules` resource always have the full set. (Do NOT use `orboto_list_agent_instructions` to read the rules — that manages rule blocks for admins.) Core non-negotiables: ticket-first (claim or create a ticket before touching code), one commit per ticket with the ticket key in the subject line, push after each commit, and never mark work done that is not actually done.',
        ].join('\n\n'),
        workingRules,
      ),
    },
  );

  // ORB-1331 — one-time session-start nudge. The state object lives for
  // the lifetime of THIS server instance: the HTTP transport builds one
  // server per session and the stdio transport one per process, so a
  // single flag object is per-session (HTTP) / process-local (stdio)
  // without any session-lifecycle plumbing. Shared by reference into
  // every tool's dispatch wrapper below.
  const nudgeState = createNudgeState();

  // ORB-311 — every tool dispatch posts one row to /admin/mcp/instrument
  // via the withMetrics wrapper. `reg` is a one-line shim around
  // `server.registerTool` that adds the metrics layer at registration
  // time; per-tool files stay metrics-unaware.
  const reg = registerWithMetrics(server, client, opts.userAgentSuffix, nudgeState);

  // Tools — alphabetical-ish by concept. Each tool file owns its
  // input/output schema; the server just glues names to handlers.
  reg('orboto_ai_status', aiStatusToolConfig, makeAiStatusHandler(client));
  reg('orboto_embedding_status', embeddingStatusToolConfig, makeEmbeddingStatusHandler(client));
  reg('orboto_ai_usage', aiUsageToolConfig, makeAiUsageHandler(client));
  // ORB-1093 — session-start / post-compact re-orientation digest.
  reg('orboto_session_start', sessionStartToolConfig, makeSessionStartHandler(client));
  // ORB-1089 — manage the configurable coding-agent rule blocks (admin:ai:write).
  reg('orboto_list_agent_instructions', listAgentInstructionsToolConfig, makeListAgentInstructionsHandler(client));
  reg('orboto_create_agent_instruction', createAgentInstructionToolConfig, makeCreateAgentInstructionHandler(client));
  reg('orboto_update_agent_instruction', updateAgentInstructionToolConfig, makeUpdateAgentInstructionHandler(client));
  reg('orboto_reset_agent_instruction', resetAgentInstructionToolConfig, makeResetAgentInstructionHandler(client));
  reg('orboto_delete_agent_instruction', deleteAgentInstructionToolConfig, makeDeleteAgentInstructionHandler(client));
  // ORB-705 — Multi-Agent Coordination tools (heartbeat, presence,
  // directed notify). Layered on the ORB-704 REST surface.
  reg('orboto_agent_heartbeat', agentHeartbeatToolConfig, makeAgentHeartbeatHandler(client));
  reg('orboto_agent_presence', agentPresenceToolConfig, makeAgentPresenceHandler(client));
  reg('orboto_agent_notify', agentNotifyToolConfig, makeAgentNotifyHandler(client));
  // ORB-964 — scoped fan-out for multi-agent coordination.
  reg('orboto_agent_broadcast', agentBroadcastToolConfig, makeAgentBroadcastHandler(client));
  reg('orboto_list_projects', listProjectsToolConfig, makeListProjectsHandler(client));
  reg('orboto_get_project', getProjectToolConfig, makeGetProjectHandler(client));
  reg('orboto_get_project_primer', getProjectPrimerToolConfig, makeGetProjectPrimerHandler(client));
  reg('orboto_list_tickets', listTicketsToolConfig, makeListTicketsHandler(client));
  reg('orboto_critical_path', criticalPathToolConfig, makeCriticalPathHandler(client));
  reg('orboto_analytics', analyticsToolConfig, makeAnalyticsHandler(client));
  reg('orboto_get_ticket', getTicketToolConfig, makeGetTicketHandler(client));
  reg('orboto_get_checklists', getChecklistsToolConfig, makeGetChecklistsHandler(client));
  reg('orboto_my_tickets', myTicketsToolConfig, makeMyTicketsHandler(client));
  reg('orboto_list_milestones', listMilestonesToolConfig, makeListMilestonesHandler(client));
  reg('orboto_get_milestone', getMilestoneToolConfig, makeGetMilestoneHandler(client));
  reg('orboto_search', searchToolConfig, makeSearchHandler(client));
  reg('orboto_query', queryToolConfig, makeQueryHandler(client));
  reg('orboto_customer_report', customerReportToolConfig, makeCustomerReportHandler(client));
  reg('orboto_requirements_spec', requirementsSpecToolConfig, makeRequirementsSpecHandler(client));
  reg('orboto_list_doc_spaces', listDocSpacesToolConfig, makeListDocSpacesHandler(client));
  reg('orboto_get_doc', getDocToolConfig, makeGetDocHandler(client));
  // ORB-1342 (epic ORB-1339) - context-efficient doc snippet search +
  // targeted edits. Wrap GET /docs/search (ORB-1340) and POST
  // /docs/:id/edits (ORB-1341). Prefer these over get_doc + update_doc for
  // small changes to a large doc: find a passage by snippet, change it by
  // diff, never transfer the full body in either direction.
  reg('orboto_search_docs', searchDocsToolConfig, makeSearchDocsHandler(client));
  reg('orboto_edit_doc', editDocToolConfig, makeEditDocHandler(client));
  reg('orboto_edit_doc_section', editDocSectionToolConfig, makeEditDocSectionHandler(client));
  // ORB-912 — doc-spaces CRUD + list docs in a space. Closes the
  // first slice of the MCP doc-surface parity gap (epic ORB-911).
  reg('orboto_create_doc_space', createDocSpaceToolConfig, makeCreateDocSpaceHandler(client));
  reg('orboto_update_doc_space', updateDocSpaceToolConfig, makeUpdateDocSpaceHandler(client));
  reg('orboto_delete_doc_space', deleteDocSpaceToolConfig, makeDeleteDocSpaceHandler(client));
  reg('orboto_list_docs_in_space', listDocsInSpaceToolConfig, makeListDocsInSpaceHandler(client));
  // ORB-913 — doc-page CRUD (plain create + update + delete + move).
  reg('orboto_create_doc', createDocToolConfig, makeCreateDocHandler(client));
  reg('orboto_update_doc', updateDocToolConfig, makeUpdateDocHandler(client));
  reg('orboto_delete_doc', deleteDocToolConfig, makeDeleteDocHandler(client));
  reg('orboto_move_doc', moveDocToolConfig, makeMoveDocHandler(client));
  // ORB-914 — doc-attachments (upload + list + delete).
  reg('orboto_upload_doc_attachment', uploadDocAttachmentToolConfig, makeUploadDocAttachmentHandler(client));
  reg('orboto_list_doc_attachments', listDocAttachmentsToolConfig, makeListDocAttachmentsHandler(client));
  reg('orboto_delete_doc_attachment', deleteDocAttachmentToolConfig, makeDeleteDocAttachmentHandler(client));
  // ORB-1455 - ticket-attachment read + view (list metadata, fetch bytes /
  // image content block). Complements orboto_attach_to_ticket (write-only).
  reg('orboto_list_ticket_attachments', listTicketAttachmentsToolConfig, makeListTicketAttachmentsHandler(client));
  reg('orboto_get_attachment', getAttachmentToolConfig, makeGetAttachmentHandler(client));
  // ORB-915 — doc export (Markdown + PDF).
  reg('orboto_export_doc_md', exportDocMdToolConfig, makeExportDocMdHandler(client));
  reg('orboto_export_doc_pdf', exportDocPdfToolConfig, makeExportDocPdfHandler(client));
  // ORB-916 — doc revision history (list + get + restore). Closes
  // the last slice of the doc-surface parity gap (epic ORB-911).
  reg('orboto_list_doc_revisions', listDocRevisionsToolConfig, makeListDocRevisionsHandler(client));
  reg('orboto_get_doc_revision', getDocRevisionToolConfig, makeGetDocRevisionHandler(client));
  reg('orboto_restore_doc_revision', restoreDocRevisionToolConfig, makeRestoreDocRevisionHandler(client));
  // ORB-917 — doc comments (list + post + resolve + delete).
  reg('orboto_list_doc_comments', listDocCommentsToolConfig, makeListDocCommentsHandler(client));
  reg('orboto_post_doc_comment', postDocCommentToolConfig, makePostDocCommentHandler(client));
  reg('orboto_resolve_doc_comment', resolveDocCommentToolConfig, makeResolveDocCommentHandler(client));
  reg('orboto_update_doc_comment', updateDocCommentToolConfig, makeUpdateDocCommentHandler(client));
  reg('orboto_delete_doc_comment', deleteDocCommentToolConfig, makeDeleteDocCommentHandler(client));
  reg('orboto_update_public_holiday', updatePublicHolidayToolConfig, makeUpdatePublicHolidayHandler(client));
  reg('orboto_update_company_closure', updateCompanyClosureToolConfig, makeUpdateCompanyClosureHandler(client));
  reg('orboto_update_absence', updateAbsenceToolConfig, makeUpdateAbsenceHandler(client));
  reg('orboto_list_cross_project_links', listCrossProjectLinksToolConfig, makeListCrossProjectLinksHandler(client));
  reg('orboto_add_cross_project_link', addCrossProjectLinkToolConfig, makeAddCrossProjectLinkHandler(client));
  reg('orboto_update_cross_project_link', updateCrossProjectLinkToolConfig, makeUpdateCrossProjectLinkHandler(client));
  reg('orboto_remove_cross_project_link', removeCrossProjectLinkToolConfig, makeRemoveCrossProjectLinkHandler(client));
  // ORB-918 — duplicate-space + resolve-links. Closes the doc-surface
  // parity epic (ORB-911) — every doc-API endpoint now has an MCP
  // pendant.
  reg('orboto_duplicate_doc_space', duplicateDocSpaceToolConfig, makeDuplicateDocSpaceHandler(client));
  reg('orboto_resolve_doc_smart_links', resolveDocSmartLinksToolConfig, makeResolveDocSmartLinksHandler(client));
  // ORB-855 — LLM-Wiki tools (ingest / ask / lint / plan-apply / record /
  // append-section / flag-stale). Thin wrappers over the Phase B/C/D routes.
  reg('orboto_wiki_ingest_url', wikiIngestUrlToolConfig, makeWikiIngestUrlHandler(client));
  reg('orboto_wiki_ask', wikiAskToolConfig, makeWikiAskHandler(client));
  reg('orboto_wiki_lint', wikiLintToolConfig, makeWikiLintHandler(client));
  reg('orboto_wiki_plan_update', wikiPlanUpdateToolConfig, makeWikiPlanUpdateHandler(client));
  reg('orboto_wiki_apply_plan', wikiApplyPlanToolConfig, makeWikiApplyPlanHandler(client));
  reg('orboto_wiki_record', wikiRecordToolConfig, makeWikiRecordHandler(client));
  reg('orboto_wiki_append_section', wikiAppendSectionToolConfig, makeWikiAppendSectionHandler(client));
  reg('orboto_wiki_flag_stale', wikiFlagStaleToolConfig, makeWikiFlagStaleHandler(client));
  reg('orboto_wiki_save_answer', wikiSaveAnswerToolConfig, makeWikiSaveAnswerHandler(client));
  // ORB-862 — personal AI-preference facts (owner-scoped).
  reg('orboto_personal_fact_list', personalFactListToolConfig, makePersonalFactListHandler(client));
  reg('orboto_personal_fact_add', personalFactAddToolConfig, makePersonalFactAddHandler(client));
  reg('orboto_personal_fact_update', personalFactUpdateToolConfig, makePersonalFactUpdateHandler(client));
  reg('orboto_personal_fact_delete', personalFactDeleteToolConfig, makePersonalFactDeleteHandler(client));
  reg('orboto_get_timer', getTimerToolConfig, makeGetTimerHandler(client));
  reg('orboto_list_git_app_installations', listGitAppInstallationsToolConfig, makeListGitAppInstallationsHandler(client));

  // ORB-309 Phase C — write tools (Group 1: ticket mutations).
  // Each respects the API's PBAC cascade — a 403 surfaces as
  // OrbotoApiError → MCP throws → client sees an isError response.
  reg('orboto_create_ticket', createTicketToolConfig, makeCreateTicketHandler(client));
  reg('orboto_update_ticket', updateTicketToolConfig, makeUpdateTicketHandler(client));
  reg('orboto_move_ticket', moveTicketToolConfig, makeMoveTicketHandler(client));
  reg('orboto_close_ticket', closeTicketToolConfig, makeCloseTicketHandler(client));
  reg('orboto_delete_ticket', deleteTicketToolConfig, makeDeleteTicketHandler(client));
  reg('orboto_comment', commentToolConfig, makeCommentHandler(client));
  reg('orboto_update_comment', updateCommentToolConfig, makeUpdateCommentHandler(client));
  reg('orboto_delete_comment', deleteCommentToolConfig, makeDeleteCommentHandler(client));
  reg('orboto_assign', assignToolConfig, makeAssignHandler(client));
  reg('orboto_unassign', unassignToolConfig, makeUnassignHandler(client));
  reg('orboto_label_ticket', labelTicketToolConfig, makeLabelTicketHandler(client));
  reg('orboto_unlabel_ticket', unlabelTicketToolConfig, makeUnlabelTicketHandler(client));
  reg('orboto_set_milestone', setMilestoneToolConfig, makeSetMilestoneHandler(client));

  // ORB-1037 — RACI agent surfaces: read the matrix + set a person's role.
  reg('orboto_raci', raciToolConfig, makeRaciHandler(client));
  reg('orboto_set_raci', setRaciToolConfig, makeSetRaciHandler(client));

  // ORB-453 — ticket-dependency tools (3-way-sync gap filed after the
  // skill wrapper landed in ORB-452). Same idempotent-on-409/404
  // semantics as orboto_assign / orboto_unassign.
  reg('orboto_add_ticket_dependency', addTicketDependencyToolConfig, makeAddTicketDependencyHandler(client));
  reg('orboto_remove_ticket_dependency', removeTicketDependencyToolConfig, makeRemoveTicketDependencyHandler(client));
  reg('orboto_list_ticket_dependencies', listTicketDependenciesToolConfig, makeListTicketDependenciesHandler(client));

  // ORB-309 Phase C — Group 2: time tools.
  reg('orboto_timer_start', timerStartToolConfig, makeTimerStartHandler(client));
  reg('orboto_timer_stop', timerStopToolConfig, makeTimerStopHandler(client));
  reg('orboto_log_time', logTimeToolConfig, makeLogTimeHandler(client));
  reg('orboto_list_time_entries', listTimeEntriesToolConfig, makeListTimeEntriesHandler(client));
  reg('orboto_edit_time_entry', editTimeEntryToolConfig, makeEditTimeEntryHandler(client));
  reg('orboto_delete_time_entry', deleteTimeEntryToolConfig, makeDeleteTimeEntryHandler(client));

  // ORB-309 Phase C — Group 3: checklist writes (ORB-234 surface).
  reg('orboto_check', checkToolConfig, makeCheckHandler(client));
  reg('orboto_uncheck', uncheckToolConfig, makeUncheckHandler(client));
  reg('orboto_add_check', addCheckToolConfig, makeAddCheckHandler(client));
  reg('orboto_remove_check', removeCheckToolConfig, makeRemoveCheckHandler(client));
  reg('orboto_new_checklist', newChecklistToolConfig, makeNewChecklistHandler(client));

  // ORB-309 Phase C — Group 4: admin-only tools. Each call hits a
  // route gated on super-admin / admin:* permissions; a non-admin
  // caller's 403 surfaces as a readable error from rewrite403().
  reg('orboto_list_users', listUsersToolConfig, makeListUsersHandler(client));
  reg('orboto_get_audit_log', getAuditLogToolConfig, makeGetAuditLogHandler(client));
  reg('orboto_trigger_backup', triggerBackupToolConfig, makeTriggerBackupHandler(client));
  reg('orboto_create_full_backup', createFullBackupToolConfig, makeCreateFullBackupHandler(client));
  reg('orboto_list_backups', listBackupsToolConfig, makeListBackupsHandler(client));
  reg('orboto_download_backup', downloadBackupToolConfig, makeDownloadBackupHandler(client));

  // ORB-510 / ORB-513 — primer-fact tools. Wraps the ORB-511 REST
  // surface so agents can record structured project facts that the
  // primer renderer (ORB-512) surfaces at session start. The skill
  // rule (ORB-514) tells agents *when* to record; these are the *how*.
  reg('orboto_primer_fact_list', primerFactListToolConfig, makePrimerFactListHandler(client));
  reg('orboto_primer_fact_add', primerFactAddToolConfig, makePrimerFactAddHandler(client));
  reg('orboto_primer_fact_update', primerFactUpdateToolConfig, makePrimerFactUpdateHandler(client));
  reg('orboto_primer_fact_supersede', primerFactSupersedeToolConfig, makePrimerFactSupersedeHandler(client));
  reg('orboto_primer_fact_verify', primerFactVerifyToolConfig, makePrimerFactVerifyHandler(client));
  reg('orboto_primer_fact_delete', primerFactDeleteToolConfig, makePrimerFactDeleteHandler(client));

  // ORB-799 — wrapper-feature-parity gap-close. Eight clusters:
  //   1. Identity   (whoami)
  //   2. Composite  (claim, unclaim)
  //   3. Milestone CRUD (create, close, update)
  //   4. Project listings (statuses, labels)
  //   5. Bulk writes (patch, move, close, comment, assign, unassign)
  //   6. Docs-AI (ask, ingest-url, ingest-file)
  //   7. Attachments (attach-to-ticket)
  //   8. Re-parenting (set-parent — symmetric to set_milestone)
  reg('orboto_whoami', whoamiToolConfig, makeWhoamiHandler(client));
  reg('orboto_claim', claimToolConfig, makeClaimHandler(client));
  reg('orboto_unclaim', unclaimToolConfig, makeUnclaimHandler(client));
  // ORB-1223 - approval / sign-off gates.
  reg('orboto_list_approvals', listApprovalsToolConfig, makeListApprovalsHandler(client));
  reg('orboto_approval_decide', approvalDecideToolConfig, makeApprovalDecideHandler(client));
  reg('orboto_create_milestone', createMilestoneToolConfig, makeCreateMilestoneHandler(client));
  reg('orboto_close_milestone', closeMilestoneToolConfig, makeCloseMilestoneHandler(client));
  reg('orboto_update_milestone', updateMilestoneToolConfig, makeUpdateMilestoneHandler(client));
  reg('orboto_list_ticket_statuses', listTicketStatusesToolConfig, makeListTicketStatusesHandler(client));
  reg('orboto_list_labels', listLabelsToolConfig, makeListLabelsHandler(client));
  reg('orboto_create_label', createLabelToolConfig, makeCreateLabelHandler(client));
  reg('orboto_bulk_patch_tickets', bulkPatchTicketsToolConfig, makeBulkPatchTicketsHandler(client));
  reg('orboto_bulk_move_tickets', bulkMoveTicketsToolConfig, makeBulkMoveTicketsHandler(client));
  reg('orboto_bulk_close_tickets', bulkCloseTicketsToolConfig, makeBulkCloseTicketsHandler(client));
  reg('orboto_bulk_comment_tickets', bulkCommentTicketsToolConfig, makeBulkCommentTicketsHandler(client));
  reg('orboto_bulk_assign_tickets', bulkAssignTicketsToolConfig, makeBulkAssignTicketsHandler(client));
  reg('orboto_bulk_unassign_tickets', bulkUnassignTicketsToolConfig, makeBulkUnassignTicketsHandler(client));
  reg('orboto_ask_docs', askDocsToolConfig, makeAskDocsHandler(client));
  reg('orboto_ingest_url', ingestUrlToolConfig, makeIngestUrlHandler(client));
  reg('orboto_ingest_file', ingestFileToolConfig, makeIngestFileHandler(client));
  reg('orboto_attach_to_ticket', attachToTicketToolConfig, makeAttachToTicketHandler(client));
  reg('orboto_set_parent', setParentToolConfig, makeSetParentHandler(client));
  reg('orboto_update_project', updateProjectToolConfig, makeUpdateProjectHandler(client));
  reg('orboto_create_project', createProjectToolConfig, makeCreateProjectHandler(client));
  reg('orboto_archive_project', archiveProjectToolConfig, makeArchiveProjectHandler(client));
  reg('orboto_check_similar', checkSimilarToolConfig, makeCheckSimilarHandler(client));
  reg('orboto_admin_translation_list', listAdminTranslationsToolConfig, makeListAdminTranslationsHandler(client));
  reg('orboto_admin_translation_approve', approveTranslationToolConfig, makeApproveTranslationHandler(client));
  reg('orboto_admin_translation_revert', revertTranslationToolConfig, makeAdminRevertTranslationHandler(client));
  reg('orboto_admin_agent_drift_list', listAgentDriftToolConfig, makeListAgentDriftHandler(client));
  reg('orboto_admin_agent_drift_resolve', resolveAgentDriftToolConfig, makeResolveAgentDriftHandler(client));

  // ORB-310 Phase D — read-only `orboto://…` URI resources +
  // task-shaped Prompt templates the MCP client offers in its UI.
  registerOrbotoResources(server, client);
  registerOrbotoPrompts(server);

  // ORB-940 — resources/subscribe + resources/unsubscribe. The Set
  // is shared by reference with the transport's event-bridge, which
  // is the actual sender of `notifications/resources/updated`. We
  // resolve immediately with an empty result either way — the spec
  // allows that, and the bridge does the real work.
  if (opts.subscriptions) {
    const subs = opts.subscriptions;
    server.server.setRequestHandler(SubscribeRequestSchema, async (req) => {
      subs.add(req.params.uri);
      // ORB-940 follow-up — stderr-log every subscribe/unsubscribe so
      // operators can see in the MCP container log whether the AI
      // client actually opts into live updates (vs. just reading the
      // resource once). Diagnostic only — never throw from here.
      try { process.stderr.write(`[orboto-mcp] subscribe → ${req.params.uri} (total subs: ${subs.size})\n`); } catch { /* ignore */ }
      return {};
    });
    server.server.setRequestHandler(UnsubscribeRequestSchema, async (req) => {
      subs.delete(req.params.uri);
      try { process.stderr.write(`[orboto-mcp] unsubscribe → ${req.params.uri} (remaining: ${subs.size})\n`); } catch { /* ignore */ }
      return {};
    });
  }

  return server;
}
