/**
 * ORB-244 Phase A/B — MCP server factory.
 *
 * Builds an `McpServer` with the registered tool set + a handle to
 * the Orboto REST client. Transport is picked by the process entry
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
import { SubscribeRequestSchema, UnsubscribeRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { OrbotoClient, type OrbotoClientConfig } from './orboto-client.js';
import { registerOrbotoResources } from './resources.js';
import { registerOrbotoPrompts } from './prompts.js';
import { registerWithMetrics } from './with-metrics.js';
import { aiStatusToolConfig, makeAiStatusHandler } from './tools/ai-status.js';
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
import { getTicketToolConfig, makeGetTicketHandler } from './tools/get-ticket.js';
import { myTicketsToolConfig, makeMyTicketsHandler } from './tools/my-tickets.js';
import {
  listMilestonesToolConfig, makeListMilestonesHandler,
  getMilestoneToolConfig, makeGetMilestoneHandler,
} from './tools/milestones.js';
import { searchToolConfig, makeSearchHandler } from './tools/search.js';
import { queryToolConfig, makeQueryHandler } from './tools/query.js';
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
  uploadDocAttachmentToolConfig, makeUploadDocAttachmentHandler,
  listDocAttachmentsToolConfig, makeListDocAttachmentsHandler,
  deleteDocAttachmentToolConfig, makeDeleteDocAttachmentHandler,
} from './tools/doc-attachments.js';
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
  commentToolConfig, makeCommentHandler,
  assignToolConfig, makeAssignHandler,
  unassignToolConfig, makeUnassignHandler,
  setMilestoneToolConfig, makeSetMilestoneHandler,
  addTicketDependencyToolConfig, makeAddTicketDependencyHandler,
  removeTicketDependencyToolConfig, makeRemoveTicketDependencyHandler,
  listTicketDependenciesToolConfig, makeListTicketDependenciesHandler,
} from './tools/ticket-writes.js';
import {
  timerStartToolConfig, makeTimerStartHandler,
  timerStopToolConfig, makeTimerStopHandler,
  logTimeToolConfig, makeLogTimeHandler,
} from './tools/time-writes.js';
import {
  checkToolConfig, makeCheckHandler,
  uncheckToolConfig, makeUncheckHandler,
  addCheckToolConfig, makeAddCheckHandler,
  newChecklistToolConfig, makeNewChecklistHandler,
} from './tools/checklist-writes.js';
import {
  listUsersToolConfig, makeListUsersHandler,
  getAuditLogToolConfig, makeGetAuditLogHandler,
  triggerBackupToolConfig, makeTriggerBackupHandler,
} from './tools/admin-writes.js';
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
  createMilestoneToolConfig, makeCreateMilestoneHandler,
  closeMilestoneToolConfig, makeCloseMilestoneHandler,
  updateMilestoneToolConfig, makeUpdateMilestoneHandler,
} from './tools/milestones.js';
import {
  listTicketStatusesToolConfig, makeListTicketStatusesHandler,
  listLabelsToolConfig, makeListLabelsHandler,
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

export function buildOrbotoMcpServer(opts: BuildServerOptions): McpServer {
  const client = new OrbotoClient(opts);

  const server = new McpServer(
    { name: 'orboto', version: '0.51.0' },
    {
      // ORB-940 — advertise resources/subscribe so MCP-aware clients
      // (Claude Desktop, Cursor) wire up live updates instead of
      // polling. Even when no bridge is hooked up (stdio sessions)
      // the capability stays on; subscriptions just stay quiet.
      capabilities: {
        resources: { subscribe: true, listChanged: true },
      },
      // `instructions` appears in the system-prompt-style block some
      // MCP clients inject before the user's first message. Keep it
      // short + specific; avoid walls of text.
      instructions: [
        'Orboto is a ticket + project management system.',
        'Use `orboto_list_projects` first to discover what the user can see.',
        'Ticket keys look like `PROJ-123`; the first segment is the project key.',
        'For "what am I working on?" prefer `orboto_my_tickets`; for "anything about X?" prefer `orboto_search`.',
        'Checklists: `orboto_get_ticket` includes them inline; use `orboto_get_checklists` when you only need the items. A linked-ticket suffix (`↪ [ACME-99]`) means the item is automatically checked/unchecked as that ticket\'s status moves.',
        'Sub-tickets: `orboto_get_ticket` surfaces `parentTicket` + `children`; walk an epic via `orboto_list_tickets` with `parentTicketKey`. Use sub-tickets for steps large enough to need their own commit / time tracking / review, and checklists for one-liners inside a single ticket\'s scope. Only materialise sub-tickets / checklist items when the parent is actively being worked — pure planning tickets keep their phase plan inside the description, not as empty TODO sub-tickets that clutter every team member\'s `my-tickets` list.',
        'Big features (Epic + 3 or more phase tickets, multi-week scope): create a milestone FIRST via `orboto_create_milestone`, then file the Epic via `orboto_create_ticket(type: "epic")`, then every phase ticket as a child of the Epic. Hang Epic + every child on the same milestone via `orboto_set_milestone` straight after creation. Three small fixes or a single ticket do NOT need their own milestone — those land in `Feature Backlog` / `Bugs` / a thematic existing milestone.',
        'When you write a git commit that touches a ticket, put the ticket key (e.g. `ORB-42`) in parentheses at the END of the subject line — `feat(auth): add token rotation (ORB-42)`. This is what the Orboto git-activity parser looks for; skipping it means the commit never gets linked to the ticket.',
        'Resources (`orboto://ticket/<key>`, `orboto://doc/<id>`, `orboto://project/<key>`, `orboto://search/<query>`) return read-only Markdown — useful when the client UI lets the user pin content rather than re-asking. The `orboto://` URI scheme stays as the canonical resource prefix even after the Orboto rebrand because clients pin URIs in their UI; renaming the scheme would invalidate every saved bookmark. Prompts (`plan-sprint`, `triage-my-tickets`, `summarize-project`, `estimate-ticket`, `find-duplicates`) are one-click guided workflows the client surfaces; each emits a goal + tool sequence the model executes.',
        'All writes respect the caller\'s project-level permissions — a 403 means the API rejected the write, not the MCP server.',
      ].join(' '),
    },
  );

  // ORB-311 — every tool dispatch posts one row to /admin/mcp/instrument
  // via the withMetrics wrapper. `reg` is a one-line shim around
  // `server.registerTool` that adds the metrics layer at registration
  // time; per-tool files stay metrics-unaware.
  const reg = registerWithMetrics(server, client, opts.userAgentSuffix);

  // Tools — alphabetical-ish by concept. Each tool file owns its
  // input/output schema; the server just glues names to handlers.
  reg('orboto_ai_status', aiStatusToolConfig, makeAiStatusHandler(client));
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
  reg('orboto_get_ticket', getTicketToolConfig, makeGetTicketHandler(client));
  reg('orboto_get_checklists', getChecklistsToolConfig, makeGetChecklistsHandler(client));
  reg('orboto_my_tickets', myTicketsToolConfig, makeMyTicketsHandler(client));
  reg('orboto_list_milestones', listMilestonesToolConfig, makeListMilestonesHandler(client));
  reg('orboto_get_milestone', getMilestoneToolConfig, makeGetMilestoneHandler(client));
  reg('orboto_search', searchToolConfig, makeSearchHandler(client));
  reg('orboto_query', queryToolConfig, makeQueryHandler(client));
  reg('orboto_list_doc_spaces', listDocSpacesToolConfig, makeListDocSpacesHandler(client));
  reg('orboto_get_doc', getDocToolConfig, makeGetDocHandler(client));
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
  reg('orboto_comment', commentToolConfig, makeCommentHandler(client));
  reg('orboto_assign', assignToolConfig, makeAssignHandler(client));
  reg('orboto_unassign', unassignToolConfig, makeUnassignHandler(client));
  reg('orboto_set_milestone', setMilestoneToolConfig, makeSetMilestoneHandler(client));

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

  // ORB-309 Phase C — Group 3: checklist writes (ORB-234 surface).
  reg('orboto_check', checkToolConfig, makeCheckHandler(client));
  reg('orboto_uncheck', uncheckToolConfig, makeUncheckHandler(client));
  reg('orboto_add_check', addCheckToolConfig, makeAddCheckHandler(client));
  reg('orboto_new_checklist', newChecklistToolConfig, makeNewChecklistHandler(client));

  // ORB-309 Phase C — Group 4: admin-only tools. Each call hits a
  // route gated on super-admin / admin:* permissions; a non-admin
  // caller's 403 surfaces as a readable error from rewrite403().
  reg('orboto_list_users', listUsersToolConfig, makeListUsersHandler(client));
  reg('orboto_get_audit_log', getAuditLogToolConfig, makeGetAuditLogHandler(client));
  reg('orboto_trigger_backup', triggerBackupToolConfig, makeTriggerBackupHandler(client));

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
  reg('orboto_create_milestone', createMilestoneToolConfig, makeCreateMilestoneHandler(client));
  reg('orboto_close_milestone', closeMilestoneToolConfig, makeCloseMilestoneHandler(client));
  reg('orboto_update_milestone', updateMilestoneToolConfig, makeUpdateMilestoneHandler(client));
  reg('orboto_list_ticket_statuses', listTicketStatusesToolConfig, makeListTicketStatusesHandler(client));
  reg('orboto_list_labels', listLabelsToolConfig, makeListLabelsHandler(client));
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
