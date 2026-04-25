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
import { listProjectsToolConfig, makeListProjectsHandler } from './tools/list-projects.js';
import { getProjectToolConfig, makeGetProjectHandler } from './tools/get-project.js';
import { listTicketsToolConfig, makeListTicketsHandler } from './tools/list-tickets.js';
import { getTicketToolConfig, makeGetTicketHandler } from './tools/get-ticket.js';
import { myTicketsToolConfig, makeMyTicketsHandler } from './tools/my-tickets.js';
import {
  listMilestonesToolConfig, makeListMilestonesHandler,
  getMilestoneToolConfig, makeGetMilestoneHandler,
} from './tools/milestones.js';
import { searchToolConfig, makeSearchHandler } from './tools/search.js';
import {
  listDocSpacesToolConfig, makeListDocSpacesHandler,
  getDocToolConfig, makeGetDocHandler,
} from './tools/docs.js';
import { getTimerToolConfig, makeGetTimerHandler } from './tools/get-timer.js';
import { getChecklistsToolConfig, makeGetChecklistsHandler } from './tools/get-checklists.js';
import {
  createTicketToolConfig, makeCreateTicketHandler,
  updateTicketToolConfig, makeUpdateTicketHandler,
  moveTicketToolConfig, makeMoveTicketHandler,
  closeTicketToolConfig, makeCloseTicketHandler,
  commentToolConfig, makeCommentHandler,
  assignToolConfig, makeAssignHandler,
  unassignToolConfig, makeUnassignHandler,
  setMilestoneToolConfig, makeSetMilestoneHandler,
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
        'All writes respect the caller\'s project-level permissions — a 403 means the API rejected the write, not the MCP server.',
      ].join(' '),
    },
  );

  // Tools — alphabetical-ish by concept. Each tool file owns its
  // input/output schema; the server just glues names to handlers.
  server.registerTool('orbit_list_projects', listProjectsToolConfig, makeListProjectsHandler(client));
  server.registerTool('orbit_get_project', getProjectToolConfig, makeGetProjectHandler(client));
  server.registerTool('orbit_list_tickets', listTicketsToolConfig, makeListTicketsHandler(client));
  server.registerTool('orbit_get_ticket', getTicketToolConfig, makeGetTicketHandler(client));
  server.registerTool('orbit_get_checklists', getChecklistsToolConfig, makeGetChecklistsHandler(client));
  server.registerTool('orbit_my_tickets', myTicketsToolConfig, makeMyTicketsHandler(client));
  server.registerTool('orbit_list_milestones', listMilestonesToolConfig, makeListMilestonesHandler(client));
  server.registerTool('orbit_get_milestone', getMilestoneToolConfig, makeGetMilestoneHandler(client));
  server.registerTool('orbit_search', searchToolConfig, makeSearchHandler(client));
  server.registerTool('orbit_list_doc_spaces', listDocSpacesToolConfig, makeListDocSpacesHandler(client));
  server.registerTool('orbit_get_doc', getDocToolConfig, makeGetDocHandler(client));
  server.registerTool('orbit_get_timer', getTimerToolConfig, makeGetTimerHandler(client));

  // ORB-309 Phase C — write tools (Group 1: ticket mutations).
  // Each respects the API's PBAC cascade — a 403 surfaces as
  // OrbitApiError → MCP throws → client sees an isError response.
  server.registerTool('orbit_create_ticket', createTicketToolConfig, makeCreateTicketHandler(client));
  server.registerTool('orbit_update_ticket', updateTicketToolConfig, makeUpdateTicketHandler(client));
  server.registerTool('orbit_move_ticket', moveTicketToolConfig, makeMoveTicketHandler(client));
  server.registerTool('orbit_close_ticket', closeTicketToolConfig, makeCloseTicketHandler(client));
  server.registerTool('orbit_comment', commentToolConfig, makeCommentHandler(client));
  server.registerTool('orbit_assign', assignToolConfig, makeAssignHandler(client));
  server.registerTool('orbit_unassign', unassignToolConfig, makeUnassignHandler(client));
  server.registerTool('orbit_set_milestone', setMilestoneToolConfig, makeSetMilestoneHandler(client));

  // ORB-309 Phase C — Group 2: time tools.
  server.registerTool('orbit_timer_start', timerStartToolConfig, makeTimerStartHandler(client));
  server.registerTool('orbit_timer_stop', timerStopToolConfig, makeTimerStopHandler(client));
  server.registerTool('orbit_log_time', logTimeToolConfig, makeLogTimeHandler(client));

  // ORB-309 Phase C — Group 3: checklist writes (ORB-234 surface).
  server.registerTool('orbit_check', checkToolConfig, makeCheckHandler(client));
  server.registerTool('orbit_uncheck', uncheckToolConfig, makeUncheckHandler(client));
  server.registerTool('orbit_add_check', addCheckToolConfig, makeAddCheckHandler(client));
  server.registerTool('orbit_new_checklist', newChecklistToolConfig, makeNewChecklistHandler(client));

  return server;
}
