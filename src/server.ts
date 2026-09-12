/**
 * ORB-244 Phase A/B - MCP server factory.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { VERSION } from './version.js';
import { SubscribeRequestSchema, UnsubscribeRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { OrbotoClient, type OrbotoClientConfig } from './orboto-client.js';
import { registerOrbotoResources } from './resources.js';
import { registerOrbotoPrompts } from './prompts.js';
import { registerWithMetrics } from './with-metrics.js';
import { resolveToolset, toolInToolset, type Toolset } from './toolset.js';
import { createNudgeState } from './session-nudge.js';
import { aiStatusToolConfig, makeAiStatusHandler } from './tools/ai-status.js';
import { draftCustomerReplyToolConfig, makeDraftCustomerReplyHandler } from './tools/customer-draft.js';
import { embeddingStatusToolConfig, makeEmbeddingStatusHandler } from './tools/embedding-status.js';
import { aiUsageToolConfig, makeAiUsageHandler } from './tools/ai-usage.js';
import { sessionStartToolConfig, makeSessionStartHandler } from './tools/session-start.js';
import { loadRequiredRules } from './required-rules.js';
import { responseExpandToolConfig, makeResponseExpandHandler } from './tools/response-expand.js';
import { helpToolConfig, makeHelpHandler } from './tools/help.js';
import { apiSearchToolConfig, makeApiSearchHandler } from './tools/api-search.js';
import { apiCallToolConfig, makeApiCallHandler } from './tools/api-call.js';
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
} from './tools/agent-coordination.js';
import {
  agentBroadcastToolConfig, makeAgentBroadcastHandler,
} from './tools/agent-coordination.js';
import { agentMessagesToolConfig, makeAgentMessagesHandler } from './tools/agent-messages.js';
import { listProjectsToolConfig, makeListProjectsHandler } from './tools/list-projects.js';
import { getProjectToolConfig, makeGetProjectHandler } from './tools/get-project.js';
import { getProjectPrimerToolConfig, makeGetProjectPrimerHandler } from './tools/get-project-primer.js';
import { listTicketsToolConfig, makeListTicketsHandler } from './tools/list-tickets.js';
import { criticalPathToolConfig, makeCriticalPathHandler } from './tools/critical-path.js';
import { analyticsToolConfig, makeAnalyticsHandler } from './tools/analytics.js';
import { portfolioSummaryToolConfig, makePortfolioSummaryHandler } from './tools/portfolio.js';
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
import { gitRotateTokenToolConfig, makeGitRotateTokenHandler } from './tools/git-rotate-token.js';
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
  listTicketSchedulesToolConfig, makeListTicketSchedulesHandler,
  scheduleTicketSessionToolConfig, makeScheduleTicketSessionHandler,
  cancelTicketSessionToolConfig, makeCancelTicketSessionHandler,
} from './tools/ticket-schedules.js';
import {
  checkToolConfig, makeCheckHandler,
  uncheckToolConfig, makeUncheckHandler,
  addCheckToolConfig, makeAddCheckHandler,
  removeCheckToolConfig, makeRemoveCheckHandler,
  updateCheckToolConfig, makeUpdateCheckHandler,
  newChecklistToolConfig, makeNewChecklistHandler,
} from './tools/checklist-writes.js';
import {
  listUsersToolConfig, makeListUsersHandler,
  getAuditLogToolConfig, makeGetAuditLogHandler,
  triggerBackupToolConfig, makeTriggerBackupHandler,
} from './tools/admin-writes.js';
import { freeBusyToolConfig, makeFreeBusyHandler } from './tools/free-busy.js';
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

import { whoamiToolConfig, makeWhoamiHandler } from './tools/identity.js';
import {
  claimToolConfig, makeClaimHandler,
  unclaimToolConfig, makeUnclaimHandler,
} from './tools/claim.js';
import { reportFeedbackToolConfig, makeReportFeedbackHandler } from './tools/feedback.js';
import {
  listApprovalsToolConfig, makeListApprovalsHandler,
  approvalDecideToolConfig, makeApprovalDecideHandler,
} from './tools/approvals.js';
import {
  reviewFingerprintToolConfig, makeReviewFingerprintHandler,
  reviewPolicyCheckToolConfig, makeReviewPolicyCheckHandler,
  reviewApprovalRecordToolConfig, makeReviewApprovalRecordHandler,
} from './tools/review-policy.js';
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
  bulkCreateTicketsToolConfig, makeBulkCreateTicketsHandler,
  bulkAddTicketDependenciesToolConfig, makeBulkAddTicketDependenciesHandler,
} from './tools/bulk-create.js';
import {
  askDocsToolConfig, makeAskDocsHandler,
  ingestUrlToolConfig, makeIngestUrlHandler,
  ingestFileToolConfig, makeIngestFileHandler,
} from './tools/docs-ai.js';
import { attachToTicketToolConfig, makeAttachToTicketHandler } from './tools/attach.js';
import { setParentToolConfig, makeSetParentHandler } from './tools/set-parent.js';
import { applyAgentProfile } from './tools/shared.js';
import {
  updateProjectToolConfig, makeUpdateProjectHandler,
  createProjectToolConfig, makeCreateProjectHandler,
  archiveProjectToolConfig, makeArchiveProjectHandler,
} from './tools/update-project.js';
import { checkSimilarToolConfig, makeCheckSimilarHandler } from './tools/check-similar.js';
import {
  workSessionStartToolConfig, makeWorkSessionStartHandler,
  workSessionFinishToolConfig, makeWorkSessionFinishHandler,
  workSessionsToolConfig, makeWorkSessionsHandler,
  workSessionClaimsAddToolConfig, makeWorkSessionClaimsAddHandler,
  workSessionClaimsReleaseToolConfig, makeWorkSessionClaimsReleaseHandler,
  workStartToolConfig, makeWorkStartHandler,
  workFinishToolConfig, makeWorkFinishHandler,
} from './tools/work-sessions.js';
import { workNextToolConfig, makeWorkNextHandler } from './tools/work-next.js';
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
  /** Optional - passed through to McpServer metadata. Clients
   *  sometimes surface this in their UI. */
  clientDescription?: string;
  /** ORB-1520 - which manifest to register. `curated` (default) is the
   *  measured high-frequency set + the api_search/api_call escape
   *  hatch; `full` registers every named tool. Entry points resolve
   *  this from ORBOTO_MCP_TOOLSET (stdio) / the per-connection
   *  `?toolset=` query or `x-orboto-toolset` header (http). */
  toolset?: Toolset;
  /** ORB-940 - when present, the server registers
   *  resources/subscribe + resources/unsubscribe handlers that
   *  write into this set. The HTTP transport reads from it to
   *  decide which events to push through. Stdio sessions can pass
   *  their own set if they want live updates; without one, the
   *  resources/subscribe capability stays advertised but no events
   *  ever fire (which is correct - a stdio client without a
   *  bridge wouldn't receive them anyway). */
  subscriptions?: Set<string>;
}

/** ORB-1090 - the workspace's configurable working-rules, used as the
 *  fallback when the live fetch fails (offline / pre-1086 instance).
 *  On success these are replaced by the live assembled blocks so admin
 *  edits propagate to every new MCP connection. */
const FALLBACK_WORKING_RULES = [
  'The following are BINDING operating rules, not guidelines - follow every one exactly, on every action, without being reminded; skipping, deferring, or "interpreting" them means the task is not done.',
  'Workflow is STRICT: claim -> commit -> close, one ticket = one commit, every time (not only when reminded). Before touching code, claim an existing ticket or create one (`orboto_claim` / `orboto_create_ticket`) - never do silent, unticketed work. When the task is done make exactly ONE commit (with the ticket key in the subject), push it, then move the ticket to in_review/done with a one-line summary (`orboto_move_ticket` + `orboto_comment`). Do not leave finished work uncommitted.',
  'When you write a git commit that touches a ticket, put the ticket key (e.g. `ORB-42`) in parentheses at the END of the subject line - `feat(auth): add token rotation (ORB-42)`. The orboto git-activity parser links the commit by that key.',
  'Use sub-tickets for steps large enough to need their own commit / time tracking / review, and checklists for one-liners inside a single ticket\'s scope. Big features (Epic + 3+ phase tickets): create a milestone FIRST, then the Epic, then phase tickets as children on that milestone.',
].join(' ');

function staticMcpHints(toolset: Toolset): string {
  if (toolset === 'minimal') {
    return [
      'orboto is a ticket + project management system. Ticket keys look like `PROJ-123`; the first segment is the project key.',
      'This is the MINIMAL tool manifest (12 tools) for small context windows. Every other endpoint stays reachable: find it with `orboto_api_search`, run it with `orboto_api_call`. Bigger manifests are opt-in: `?toolset=curated` / `full` (HTTP) or ORBOTO_MCP_TOOLSET (stdio).',
      'Writes respect the caller\'s permissions - a 403 is the API refusing, not this server.',
    ].join(' ');
  }
  return [
    'orboto is a ticket + project management system.',
    'When starting on a project, call `orboto_get_project_primer(<PROJECT_KEY>)` once to load its conventions (tech stack, commands, gotchas, expected ticket language).',
    'Use `orboto_list_projects` first to discover what the user can see.',
    'Ticket keys look like `PROJ-123`; the first segment is the project key.',
    'For "what am I working on?" prefer `orboto_my_tickets`; for "anything about X?" prefer `orboto_search`.',
    toolset === 'full'
      ? 'Checklists: `orboto_get_ticket` includes them inline; use `orboto_get_checklists` when you only need the items. A linked-ticket suffix (`↪ [ACME-99]`) means the item is automatically checked/unchecked as that ticket\'s status moves.'
      : 'Checklists: `orboto_get_ticket` includes them inline. A linked-ticket suffix (`↪ [ACME-99]`) means the item is automatically checked/unchecked as that ticket\'s status moves.',
    toolset === 'curated'
      ? 'This is the CURATED tool manifest (the daily high-frequency set). The ENTIRE REST API stays reachable: find any other endpoint + its schema with `orboto_api_search`, then execute it with `orboto_api_call` - permissions are enforced server-side exactly as for named tools. The full named-tool manifest is opt-in: connect with `?toolset=full` (HTTP) or set ORBOTO_MCP_TOOLSET=full (stdio).'
      : '',
    'Resources (`orboto://rules`, `orboto://ticket/<key>`, `orboto://doc/<id>`, `orboto://project/<key>`, `orboto://search/<query>`) return read-only Markdown. The `orboto://` URI scheme stays canonical. `orboto://rules` returns the COMPLETE binding rules cap-independently (this instructions block may be truncated by the client). Prompts (`plan-sprint`, `triage-my-tickets`, `summarize-project`, `estimate-ticket`, `find-duplicates`) are one-click guided workflows.',
    'A few natural parameter spellings (`key`, `query`, `id`, `projectId`, `milestoneId`, `comment`/`message`, `max`, `page`, ...) are silently normalised to the documented name; anything else that still doesn\'t match returns an error naming the tool\'s full parameter list and the closest valid name.',
    'All writes respect the caller\'s project-level permissions - a 403 means the API rejected the write, not the MCP server.',
  ].filter((s) => s.length > 0).join(' ');
}

const INSTRUCTIONS_BUDGET = 4000;
const RULES_HEADING = 'Working rules for this workspace:\n';
const TRUNCATION_MARKER =
  '\n\n[... rules truncated to fit the client cap - read the COMPLETE rules via the orboto_session_start tool or the orboto://rules resource ...]';

export function assembleInstructions(head: string, workingRules: string, budget = INSTRUCTIONS_BUDGET): string {
  const full = `${head}\n\n${RULES_HEADING}${workingRules}`;
  if (full.length <= budget) return full;
  const room = budget - head.length - RULES_HEADING.length - TRUNCATION_MARKER.length - 2;
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
  const toolset = resolveToolset(opts.toolset, process.env.ORBOTO_MCP_TOOLSET);

  let workingRules = FALLBACK_WORKING_RULES;
  let requireSessionStart = true;
  try {
    const connectParams = new URLSearchParams();
    applyAgentProfile(connectParams);
    const connectQs = connectParams.toString();
    const res = await loadRequiredRules(client, `/agent-instructions${connectQs ? `?${connectQs}` : ''}`);
    if (res?.instructions?.trim()) workingRules = res.instructions.trim();
    requireSessionStart = res.requireSessionStart ?? true;
  } catch {
    workingRules = 'Workspace rules are unavailable. Built-in hints are not a substitute. Call orboto_session_start with forceRules and retry after connectivity or authentication recovers.';
  }

  const server = new McpServer(
    { name: 'orboto', version: VERSION },
    {
      capabilities: {
        resources: { subscribe: true, listChanged: true },
      },
      instructions: toolset === 'minimal'
        ? [
          staticMcpHints(toolset),
          'FIRST ACTION: call `orboto_session_start` - it returns the binding workspace rules plus your in-progress work. Re-run it after any context compaction. Non-negotiables: claim or create a ticket before touching code, one commit per ticket with the ticket key in the subject, push after each commit, never mark work done that is not done.',
        ].join('\n\n')
        : assembleInstructions(
          [
            staticMcpHints(toolset),
            'FIRST ACTION this session: call the `orboto_session_start` tool - it returns the complete, authoritative binding rules you must follow (plus your in-progress work). Re-run it after any context compaction. If the rules below look cut off, `orboto_session_start` and the `orboto://rules` resource always have the full set. (Do NOT use `orboto_list_agent_instructions` to read the rules - that manages rule blocks for admins.) Core non-negotiables: ticket-first (claim or create a ticket before touching code), one commit per ticket with the ticket key in the subject line, push after each commit, and never mark work done that is not actually done.',
          ].join('\n\n'),
          workingRules,
        ),
    },
  );

  const nudgeState = createNudgeState(requireSessionStart);

  const regAll = registerWithMetrics(server, client, opts.userAgentSuffix, nudgeState);
  const reg: typeof regAll = (toolName, config, handler) => {
    if (!toolInToolset(toolName, toolset)) return;
    const cfg = toolset === 'minimal' && config && 'title' in config
      ? (() => { const { title: _title, ...rest } = config; return rest; })()
      : config;
    regAll(toolName, cfg, handler);
  };

  reg('orboto_ai_status', aiStatusToolConfig, makeAiStatusHandler(client));
  reg('orboto_draft_customer_reply', draftCustomerReplyToolConfig, makeDraftCustomerReplyHandler(client));
  reg('orboto_embedding_status', embeddingStatusToolConfig, makeEmbeddingStatusHandler(client));
  reg('orboto_ai_usage', aiUsageToolConfig, makeAiUsageHandler(client));
  reg('orboto_session_start', sessionStartToolConfig, makeSessionStartHandler(client));
  reg('orboto_response_expand', responseExpandToolConfig, makeResponseExpandHandler());
  reg('orboto_help', helpToolConfig, makeHelpHandler());
  reg('orboto_api_search', apiSearchToolConfig, makeApiSearchHandler(client));
  reg('orboto_api_call', apiCallToolConfig, makeApiCallHandler(client));
  reg('orboto_list_agent_instructions', listAgentInstructionsToolConfig, makeListAgentInstructionsHandler(client));
  reg('orboto_create_agent_instruction', createAgentInstructionToolConfig, makeCreateAgentInstructionHandler(client));
  reg('orboto_update_agent_instruction', updateAgentInstructionToolConfig, makeUpdateAgentInstructionHandler(client));
  reg('orboto_reset_agent_instruction', resetAgentInstructionToolConfig, makeResetAgentInstructionHandler(client));
  reg('orboto_delete_agent_instruction', deleteAgentInstructionToolConfig, makeDeleteAgentInstructionHandler(client));
  reg('orboto_agent_heartbeat', agentHeartbeatToolConfig, makeAgentHeartbeatHandler(client));
  reg('orboto_agent_presence', agentPresenceToolConfig, makeAgentPresenceHandler(client));
  reg('orboto_agent_notify', agentNotifyToolConfig, makeAgentNotifyHandler(client));
  reg('orboto_messages', agentMessagesToolConfig, makeAgentMessagesHandler(client));
  reg('orboto_agent_broadcast', agentBroadcastToolConfig, makeAgentBroadcastHandler(client));
  reg('orboto_list_projects', listProjectsToolConfig, makeListProjectsHandler(client));
  reg('orboto_get_project', getProjectToolConfig, makeGetProjectHandler(client));
  reg('orboto_get_project_primer', getProjectPrimerToolConfig, makeGetProjectPrimerHandler(client));
  reg('orboto_list_tickets', listTicketsToolConfig, makeListTicketsHandler(client));
  reg('orboto_critical_path', criticalPathToolConfig, makeCriticalPathHandler(client));
  reg('orboto_analytics', analyticsToolConfig, makeAnalyticsHandler(client));
  reg('orboto_portfolio_summary', portfolioSummaryToolConfig, makePortfolioSummaryHandler(client));
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
  reg('orboto_search_docs', searchDocsToolConfig, makeSearchDocsHandler(client));
  reg('orboto_edit_doc', editDocToolConfig, makeEditDocHandler(client));
  reg('orboto_edit_doc_section', editDocSectionToolConfig, makeEditDocSectionHandler(client));
  reg('orboto_create_doc_space', createDocSpaceToolConfig, makeCreateDocSpaceHandler(client));
  reg('orboto_update_doc_space', updateDocSpaceToolConfig, makeUpdateDocSpaceHandler(client));
  reg('orboto_delete_doc_space', deleteDocSpaceToolConfig, makeDeleteDocSpaceHandler(client));
  reg('orboto_list_docs_in_space', listDocsInSpaceToolConfig, makeListDocsInSpaceHandler(client));
  reg('orboto_create_doc', createDocToolConfig, makeCreateDocHandler(client));
  reg('orboto_update_doc', updateDocToolConfig, makeUpdateDocHandler(client));
  reg('orboto_delete_doc', deleteDocToolConfig, makeDeleteDocHandler(client));
  reg('orboto_move_doc', moveDocToolConfig, makeMoveDocHandler(client));
  reg('orboto_upload_doc_attachment', uploadDocAttachmentToolConfig, makeUploadDocAttachmentHandler(client));
  reg('orboto_list_doc_attachments', listDocAttachmentsToolConfig, makeListDocAttachmentsHandler(client));
  reg('orboto_delete_doc_attachment', deleteDocAttachmentToolConfig, makeDeleteDocAttachmentHandler(client));
  reg('orboto_list_ticket_attachments', listTicketAttachmentsToolConfig, makeListTicketAttachmentsHandler(client));
  reg('orboto_get_attachment', getAttachmentToolConfig, makeGetAttachmentHandler(client));
  reg('orboto_export_doc_md', exportDocMdToolConfig, makeExportDocMdHandler(client));
  reg('orboto_export_doc_pdf', exportDocPdfToolConfig, makeExportDocPdfHandler(client));
  reg('orboto_list_doc_revisions', listDocRevisionsToolConfig, makeListDocRevisionsHandler(client));
  reg('orboto_get_doc_revision', getDocRevisionToolConfig, makeGetDocRevisionHandler(client));
  reg('orboto_restore_doc_revision', restoreDocRevisionToolConfig, makeRestoreDocRevisionHandler(client));
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
  reg('orboto_duplicate_doc_space', duplicateDocSpaceToolConfig, makeDuplicateDocSpaceHandler(client));
  reg('orboto_resolve_doc_smart_links', resolveDocSmartLinksToolConfig, makeResolveDocSmartLinksHandler(client));
  reg('orboto_wiki_ingest_url', wikiIngestUrlToolConfig, makeWikiIngestUrlHandler(client));
  reg('orboto_wiki_ask', wikiAskToolConfig, makeWikiAskHandler(client));
  reg('orboto_wiki_lint', wikiLintToolConfig, makeWikiLintHandler(client));
  reg('orboto_wiki_plan_update', wikiPlanUpdateToolConfig, makeWikiPlanUpdateHandler(client));
  reg('orboto_wiki_apply_plan', wikiApplyPlanToolConfig, makeWikiApplyPlanHandler(client));
  reg('orboto_wiki_record', wikiRecordToolConfig, makeWikiRecordHandler(client));
  reg('orboto_wiki_append_section', wikiAppendSectionToolConfig, makeWikiAppendSectionHandler(client));
  reg('orboto_wiki_flag_stale', wikiFlagStaleToolConfig, makeWikiFlagStaleHandler(client));
  reg('orboto_wiki_save_answer', wikiSaveAnswerToolConfig, makeWikiSaveAnswerHandler(client));
  reg('orboto_personal_fact_list', personalFactListToolConfig, makePersonalFactListHandler(client));
  reg('orboto_personal_fact_add', personalFactAddToolConfig, makePersonalFactAddHandler(client));
  reg('orboto_personal_fact_update', personalFactUpdateToolConfig, makePersonalFactUpdateHandler(client));
  reg('orboto_personal_fact_delete', personalFactDeleteToolConfig, makePersonalFactDeleteHandler(client));
  reg('orboto_get_timer', getTimerToolConfig, makeGetTimerHandler(client));
  reg('orboto_list_git_app_installations', listGitAppInstallationsToolConfig, makeListGitAppInstallationsHandler(client));
  reg('orboto_git_rotate_token', gitRotateTokenToolConfig, makeGitRotateTokenHandler(client));

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

  reg('orboto_raci', raciToolConfig, makeRaciHandler(client));
  reg('orboto_set_raci', setRaciToolConfig, makeSetRaciHandler(client));

  reg('orboto_add_ticket_dependency', addTicketDependencyToolConfig, makeAddTicketDependencyHandler(client));
  reg('orboto_remove_ticket_dependency', removeTicketDependencyToolConfig, makeRemoveTicketDependencyHandler(client));
  reg('orboto_list_ticket_dependencies', listTicketDependenciesToolConfig, makeListTicketDependenciesHandler(client));

  reg('orboto_timer_start', timerStartToolConfig, makeTimerStartHandler(client));
  reg('orboto_timer_stop', timerStopToolConfig, makeTimerStopHandler(client));
  reg('orboto_log_time', logTimeToolConfig, makeLogTimeHandler(client));
  reg('orboto_list_time_entries', listTimeEntriesToolConfig, makeListTimeEntriesHandler(client));
  reg('orboto_edit_time_entry', editTimeEntryToolConfig, makeEditTimeEntryHandler(client));
  reg('orboto_delete_time_entry', deleteTimeEntryToolConfig, makeDeleteTimeEntryHandler(client));

  reg('orboto_list_ticket_schedules', listTicketSchedulesToolConfig, makeListTicketSchedulesHandler(client));
  reg('orboto_schedule_ticket_session', scheduleTicketSessionToolConfig, makeScheduleTicketSessionHandler(client));
  reg('orboto_cancel_ticket_session', cancelTicketSessionToolConfig, makeCancelTicketSessionHandler(client));

  reg('orboto_check', checkToolConfig, makeCheckHandler(client));
  reg('orboto_uncheck', uncheckToolConfig, makeUncheckHandler(client));
  reg('orboto_add_check', addCheckToolConfig, makeAddCheckHandler(client));
  reg('orboto_remove_check', removeCheckToolConfig, makeRemoveCheckHandler(client));
  reg('orboto_update_check', updateCheckToolConfig, makeUpdateCheckHandler(client));
  reg('orboto_new_checklist', newChecklistToolConfig, makeNewChecklistHandler(client));

  reg('orboto_list_users', listUsersToolConfig, makeListUsersHandler(client));
  reg('orboto_free_busy', freeBusyToolConfig, makeFreeBusyHandler(client));
  reg('orboto_get_audit_log', getAuditLogToolConfig, makeGetAuditLogHandler(client));
  reg('orboto_trigger_backup', triggerBackupToolConfig, makeTriggerBackupHandler(client));
  reg('orboto_create_full_backup', createFullBackupToolConfig, makeCreateFullBackupHandler(client));
  reg('orboto_list_backups', listBackupsToolConfig, makeListBackupsHandler(client));
  reg('orboto_download_backup', downloadBackupToolConfig, makeDownloadBackupHandler(client));

  reg('orboto_primer_fact_list', primerFactListToolConfig, makePrimerFactListHandler(client));
  reg('orboto_primer_fact_add', primerFactAddToolConfig, makePrimerFactAddHandler(client));
  reg('orboto_primer_fact_update', primerFactUpdateToolConfig, makePrimerFactUpdateHandler(client));
  reg('orboto_primer_fact_supersede', primerFactSupersedeToolConfig, makePrimerFactSupersedeHandler(client));
  reg('orboto_primer_fact_verify', primerFactVerifyToolConfig, makePrimerFactVerifyHandler(client));
  reg('orboto_primer_fact_delete', primerFactDeleteToolConfig, makePrimerFactDeleteHandler(client));

  reg('orboto_whoami', whoamiToolConfig, makeWhoamiHandler(client));
  reg('orboto_claim', claimToolConfig, makeClaimHandler(client));
  reg('orboto_unclaim', unclaimToolConfig, makeUnclaimHandler(client));
  reg('orboto_report_feedback', reportFeedbackToolConfig, makeReportFeedbackHandler(client));
  reg('orboto_list_approvals', listApprovalsToolConfig, makeListApprovalsHandler(client));
  reg('orboto_approval_decide', approvalDecideToolConfig, makeApprovalDecideHandler(client));
  reg('orboto_review_fingerprint', reviewFingerprintToolConfig, makeReviewFingerprintHandler(client));
  reg('orboto_review_policy_check', reviewPolicyCheckToolConfig, makeReviewPolicyCheckHandler(client));
  reg('orboto_review_approval_record', reviewApprovalRecordToolConfig, makeReviewApprovalRecordHandler(client));
  reg('orboto_create_milestone', createMilestoneToolConfig, makeCreateMilestoneHandler(client));
  reg('orboto_close_milestone', closeMilestoneToolConfig, makeCloseMilestoneHandler(client));
  reg('orboto_update_milestone', updateMilestoneToolConfig, makeUpdateMilestoneHandler(client));
  reg('orboto_list_ticket_statuses', listTicketStatusesToolConfig, makeListTicketStatusesHandler(client));
  reg('orboto_list_labels', listLabelsToolConfig, makeListLabelsHandler(client));
  reg('orboto_create_label', createLabelToolConfig, makeCreateLabelHandler(client));
  reg('orboto_bulk_patch_tickets', bulkPatchTicketsToolConfig, makeBulkPatchTicketsHandler(client));
  reg('orboto_bulk_move_tickets', bulkMoveTicketsToolConfig, makeBulkMoveTicketsHandler(client));
  reg('orboto_bulk_close_tickets', bulkCloseTicketsToolConfig, makeBulkCloseTicketsHandler(client));
  reg('orboto_bulk_create_tickets', bulkCreateTicketsToolConfig, makeBulkCreateTicketsHandler(client));
  reg('orboto_bulk_add_ticket_dependencies', bulkAddTicketDependenciesToolConfig, makeBulkAddTicketDependenciesHandler(client));
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
  reg('orboto_work_session_start', workSessionStartToolConfig, makeWorkSessionStartHandler(client));
  reg('orboto_work_start', workStartToolConfig, makeWorkStartHandler(client));
  reg('orboto_work_session_finish', workSessionFinishToolConfig, makeWorkSessionFinishHandler(client));
  reg('orboto_work_finish', workFinishToolConfig, makeWorkFinishHandler(client));
  reg('orboto_work_next', workNextToolConfig, makeWorkNextHandler(client));
  reg('orboto_work_sessions', workSessionsToolConfig, makeWorkSessionsHandler(client));
  reg('orboto_work_session_claims_add', workSessionClaimsAddToolConfig, makeWorkSessionClaimsAddHandler(client));
  reg('orboto_work_session_claims_release', workSessionClaimsReleaseToolConfig, makeWorkSessionClaimsReleaseHandler(client));
  reg('orboto_admin_translation_list', listAdminTranslationsToolConfig, makeListAdminTranslationsHandler(client));
  reg('orboto_admin_translation_approve', approveTranslationToolConfig, makeApproveTranslationHandler(client));
  reg('orboto_admin_translation_revert', revertTranslationToolConfig, makeAdminRevertTranslationHandler(client));
  reg('orboto_admin_agent_drift_list', listAgentDriftToolConfig, makeListAgentDriftHandler(client));
  reg('orboto_admin_agent_drift_resolve', resolveAgentDriftToolConfig, makeResolveAgentDriftHandler(client));

  registerOrbotoResources(server, client);
  registerOrbotoPrompts(server);

  if (opts.subscriptions) {
    const subs = opts.subscriptions;
    server.server.setRequestHandler(SubscribeRequestSchema, async (req) => {
      subs.add(req.params.uri);
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
