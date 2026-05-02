/**
 * ORB-244 Phase A/B — MCP server factory.
 *
 * Builds an `McpServer` with the registered tool set + a handle to
 * the Orbit REST client. Transport is picked by the process entry
 * point (`index.ts`) based on `ORBIT_MCP_TRANSPORT=stdio|http`.
 *
 * Keeping the server factory transport-agnostic means `server.ts` is
 * the same object whether we ship stdio for Local-Proxy (Phase G
 * `@orbit/mcp-cli`) or HTTP-SSE for Self-Hosted-inline.
 *
 * Tool registrations stay in this file so adding a new tool in
 * Phase C is one diff here + one new file in `tools/`. Phase D will
 * add `registerResource` / `registerPrompt` calls here too.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { OrbitClient, type OrbitClientConfig } from './orbit-client.js';
import { registerOrbitResources } from './resources.js';
import { registerOrbitPrompts } from './prompts.js';
import { registerWithMetrics } from './with-metrics.js';
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
  listDocSpacesToolConfig, makeListDocSpacesHandler,
  getDocToolConfig, makeGetDocHandler,
} from './tools/docs.js';
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

export interface BuildServerOptions extends OrbitClientConfig {
  /** Optional — passed through to McpServer metadata. Clients
   *  sometimes surface this in their UI. */
  clientDescription?: string;
}

export function buildOrbitMcpServer(opts: BuildServerOptions): McpServer {
  const client = new OrbitClient(opts);

  const server = new McpServer(
    { name: 'orbit', version: '0.51.0' },
    {
      // `instructions` appears in the system-prompt-style block some
      // MCP clients inject before the user's first message. Keep it
      // short + specific; avoid walls of text.
      instructions: [
        'Orbit is a ticket + project management system.',
        'Use `orbit_list_projects` first to discover what the user can see.',
        'Ticket keys look like `PROJ-123`; the first segment is the project key.',
        'For "what am I working on?" prefer `orbit_my_tickets`; for "anything about X?" prefer `orbit_search`.',
        'Checklists: `orbit_get_ticket` includes them inline; use `orbit_get_checklists` when you only need the items. A linked-ticket suffix (`↪ [ACME-99]`) means the item is automatically checked/unchecked as that ticket\'s status moves.',
        'Sub-tickets: `orbit_get_ticket` surfaces `parentTicket` + `children`; walk an epic via `orbit_list_tickets` with `parentTicketKey`. Use sub-tickets for steps large enough to need their own commit / time tracking / review, and checklists for one-liners inside a single ticket\'s scope. Only materialise sub-tickets / checklist items when the parent is actively being worked — pure planning tickets keep their phase plan inside the description, not as empty TODO sub-tickets that clutter every team member\'s `my-tickets` list.',
        'When you write a git commit that touches a ticket, put the ticket key (e.g. `ORB-42`) in parentheses at the END of the subject line — `feat(auth): add token rotation (ORB-42)`. This is what the Orbit git-activity parser looks for; skipping it means the commit never gets linked to the ticket.',
        'Resources (`orbit://ticket/<key>`, `orbit://doc/<id>`, `orbit://project/<key>`, `orbit://search/<query>`) return read-only Markdown — useful when the client UI lets the user pin content rather than re-asking. Prompts (`plan-sprint`, `triage-my-tickets`, `summarize-project`, `estimate-ticket`, `find-duplicates`) are one-click guided workflows the client surfaces; each emits a goal + tool sequence the model executes.',
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
  reg('orbit_list_projects', listProjectsToolConfig, makeListProjectsHandler(client));
  reg('orbit_get_project', getProjectToolConfig, makeGetProjectHandler(client));
  reg('orbit_get_project_primer', getProjectPrimerToolConfig, makeGetProjectPrimerHandler(client));
  reg('orbit_list_tickets', listTicketsToolConfig, makeListTicketsHandler(client));
  reg('orbit_get_ticket', getTicketToolConfig, makeGetTicketHandler(client));
  reg('orbit_get_checklists', getChecklistsToolConfig, makeGetChecklistsHandler(client));
  reg('orbit_my_tickets', myTicketsToolConfig, makeMyTicketsHandler(client));
  reg('orbit_list_milestones', listMilestonesToolConfig, makeListMilestonesHandler(client));
  reg('orbit_get_milestone', getMilestoneToolConfig, makeGetMilestoneHandler(client));
  reg('orbit_search', searchToolConfig, makeSearchHandler(client));
  reg('orbit_query', queryToolConfig, makeQueryHandler(client));
  reg('orbit_list_doc_spaces', listDocSpacesToolConfig, makeListDocSpacesHandler(client));
  reg('orbit_get_doc', getDocToolConfig, makeGetDocHandler(client));
  reg('orbit_get_timer', getTimerToolConfig, makeGetTimerHandler(client));
  reg('orbit_list_git_app_installations', listGitAppInstallationsToolConfig, makeListGitAppInstallationsHandler(client));

  // ORB-309 Phase C — write tools (Group 1: ticket mutations).
  // Each respects the API's PBAC cascade — a 403 surfaces as
  // OrbitApiError → MCP throws → client sees an isError response.
  reg('orbit_create_ticket', createTicketToolConfig, makeCreateTicketHandler(client));
  reg('orbit_update_ticket', updateTicketToolConfig, makeUpdateTicketHandler(client));
  reg('orbit_move_ticket', moveTicketToolConfig, makeMoveTicketHandler(client));
  reg('orbit_close_ticket', closeTicketToolConfig, makeCloseTicketHandler(client));
  reg('orbit_comment', commentToolConfig, makeCommentHandler(client));
  reg('orbit_assign', assignToolConfig, makeAssignHandler(client));
  reg('orbit_unassign', unassignToolConfig, makeUnassignHandler(client));
  reg('orbit_set_milestone', setMilestoneToolConfig, makeSetMilestoneHandler(client));

  // ORB-453 — ticket-dependency tools (3-way-sync gap filed after the
  // skill wrapper landed in ORB-452). Same idempotent-on-409/404
  // semantics as orbit_assign / orbit_unassign.
  reg('orbit_add_ticket_dependency', addTicketDependencyToolConfig, makeAddTicketDependencyHandler(client));
  reg('orbit_remove_ticket_dependency', removeTicketDependencyToolConfig, makeRemoveTicketDependencyHandler(client));
  reg('orbit_list_ticket_dependencies', listTicketDependenciesToolConfig, makeListTicketDependenciesHandler(client));

  // ORB-309 Phase C — Group 2: time tools.
  reg('orbit_timer_start', timerStartToolConfig, makeTimerStartHandler(client));
  reg('orbit_timer_stop', timerStopToolConfig, makeTimerStopHandler(client));
  reg('orbit_log_time', logTimeToolConfig, makeLogTimeHandler(client));

  // ORB-309 Phase C — Group 3: checklist writes (ORB-234 surface).
  reg('orbit_check', checkToolConfig, makeCheckHandler(client));
  reg('orbit_uncheck', uncheckToolConfig, makeUncheckHandler(client));
  reg('orbit_add_check', addCheckToolConfig, makeAddCheckHandler(client));
  reg('orbit_new_checklist', newChecklistToolConfig, makeNewChecklistHandler(client));

  // ORB-309 Phase C — Group 4: admin-only tools. Each call hits a
  // route gated on super-admin / admin:* permissions; a non-admin
  // caller's 403 surfaces as a readable error from rewrite403().
  reg('orbit_list_users', listUsersToolConfig, makeListUsersHandler(client));
  reg('orbit_get_audit_log', getAuditLogToolConfig, makeGetAuditLogHandler(client));
  reg('orbit_trigger_backup', triggerBackupToolConfig, makeTriggerBackupHandler(client));

  // ORB-510 / ORB-513 — primer-fact tools. Wraps the ORB-511 REST
  // surface so agents can record structured project facts that the
  // primer renderer (ORB-512) surfaces at session start. The skill
  // rule (ORB-514) tells agents *when* to record; these are the *how*.
  reg('orbit_primer_fact_list', primerFactListToolConfig, makePrimerFactListHandler(client));
  reg('orbit_primer_fact_add', primerFactAddToolConfig, makePrimerFactAddHandler(client));
  reg('orbit_primer_fact_update', primerFactUpdateToolConfig, makePrimerFactUpdateHandler(client));
  reg('orbit_primer_fact_supersede', primerFactSupersedeToolConfig, makePrimerFactSupersedeHandler(client));
  reg('orbit_primer_fact_verify', primerFactVerifyToolConfig, makePrimerFactVerifyHandler(client));
  reg('orbit_primer_fact_delete', primerFactDeleteToolConfig, makePrimerFactDeleteHandler(client));

  // ORB-310 Phase D — read-only `orbit://…` URI resources +
  // task-shaped Prompt templates the MCP client offers in its UI.
  registerOrbitResources(server, client);
  registerOrbitPrompts(server);

  return server;
}
