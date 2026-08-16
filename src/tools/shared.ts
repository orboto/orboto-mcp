/**
 * ORB-244 Phase B — shared helpers for the read-tool suite.
 *
 * Every user-facing MCP tool takes **keys** where possible
 * (`ACME` for a project, `ACME-42` for a ticket) because that's what
 * the human typing in Claude knows. The API endpoints, by contrast,
 * take UUIDs for the cascade-friendly join path. These helpers do
 * the key→UUID resolution in one place.
 */
import { OrbotoApiError, type OrbotoClient } from '../orboto-client.js';

export interface ProjectRow {
  id: string;
  key: string;
  name: string;
  description: string | null;
  status: string;
  // ORB-994 — per-project content language, null = inherit workspace.
  language?: string | null;
  // ORB-1040 — RACI opt-in. Agents must not raise/set RACI unless true.
  raciEnabled?: boolean;
}

export async function resolveProjectByKey(
  client: OrbotoClient,
  key: string,
): Promise<ProjectRow> {
  try {
    return await client.get<ProjectRow>(`/projects/by-key/${encodeURIComponent(key)}`);
  } catch (err) {
    if (err instanceof OrbotoApiError && err.status === 404) {
      throw new Error(`Project "${key}" not found (or not visible to your account).`);
    }
    throw err;
  }
}

export interface TicketRow {
  id: string;
  projectId: string;
  milestoneId: string | null;
  /** ORB-1023 — resolved milestone name on enriched responses (by-id + lists);
   *  null when no milestone, undefined on the bare by-key resolver row. */
  milestoneName?: string | null;
  parentTicketId?: string | null;
  ticketKey: string | null;
  ticketNumber: number | null;
  title: string;
  description?: string | null;
  status: string;
  statusName?: string;
  statusCategory?: string;
  type: string;
  priority: string;
  // ORB-1608 — role-aware commit policy (implementation/docs/review/admin/
  // epic). Absent on responses the enrich pipeline didn't touch (falls
  // back to the API's 'implementation' default when read).
  deliveryMode?: string;
  estimatedTimeMinutes: number;
  loggedMinutes?: number;
  dueDate: string | null;
  startDate?: string | null;
  isPrivate: boolean;
  closedAt?: string | null;
  createdAt?: string;
  updatedAt?: string;
  assignees?: Array<{ id: string; email: string; fullName: string }>;
  // ORB-1034 — full RACI roster (R/A/C/I). Present when the project has RACI
  // enabled; `assignees` above stays the Responsible+Accountable subset.
  raci?: Array<{ userId: string; email: string; fullName: string; role: 'R' | 'A' | 'C' | 'I' }>;
  labels?: Array<{ id: string; name: string }>;
  commentCount?: number;
  gitActivityCount?: number;
  checklistProgress?: { done: number; total: number };
  // ORB-1605 — in_review, zero ingested git_activities, but the project
  // HAS an active git connection: closing verification may be blocked
  // on stalled commit/PR ingestion rather than genuinely unlinked work.
  // Absent (not false) on responses the enrich pipeline didn't touch.
  waitingForGitIngestion?: boolean;
}


/**
 * ORB-1699 - the ONE agent-facing list-row builder. A list call is a
 * decision aid ("which of these do I open?"); the default row carries
 * exactly what that decision + the filters read back. `verbose: true`
 * restores the full shape (uuid, labels, minutes, ingestion signal).
 * list_tickets, my_tickets and query all consume THIS builder - trimming
 * one tool and leaving the siblings fat is the class-not-instance
 * failure the workspace rules warn about.
 */
export function agentTicketListRow(t: TicketRow, verbose = false): Record<string, unknown> {
  if (verbose) {
    return {
      // ORB-1179 - uuid for write tools that want it without a lookup.
      id: t.id,
      key: t.ticketKey,
      title: t.title,
      status: t.statusName ?? t.status,
      statusCategory: t.statusCategory ?? null,
      priority: t.priority,
      type: t.type,
      dueDate: t.dueDate ?? null,
      assigneeNames: (t.assignees ?? []).map((a) => a.fullName || a.email),
      labels: (t.labels ?? []).map((l) => l.name),
      estimatedTimeMinutes: t.estimatedTimeMinutes,
      loggedMinutes: t.loggedMinutes ?? 0,
      milestoneName: t.milestoneName ?? null,
      createdAt: t.createdAt ?? null,
      updatedAt: t.updatedAt ?? null,
      ...(t.waitingForGitIngestion ? { waitingForGitIngestion: true } : {}),
    };
  }
  // Lean row: fields at their DEFAULT value are omitted entirely - a
  // reader treats absence as "task / normal / no due date / unassigned".
  // The list is a decision aid; the full picture is one get_ticket away.
  const assigneeNames = (t.assignees ?? []).map((a) => a.fullName || a.email);
  return {
    key: t.ticketKey,
    title: t.title,
    statusCategory: t.statusCategory ?? null,
    ...(t.priority && t.priority !== 'normal' ? { priority: t.priority } : {}),
    ...(t.type && t.type !== 'task' ? { type: t.type } : {}),
    ...(t.dueDate ? { dueDate: t.dueDate } : {}),
    ...(assigneeNames.length > 0 ? { assigneeNames } : {}),
    // ORB-1605 - only present when it fires; absent costs zero chars.
    ...(t.waitingForGitIngestion ? { waitingForGitIngestion: true } : {}),
  };
}

/**
 * Resolve a `PROJ-123` ticket key to a fully-hydrated ticket row.
 * Splits on the first `-` — project keys are upper-case alphanumerics
 * (max 20 chars) and never contain `-`, so the split is unambiguous.
 */
export async function resolveTicketByKey(
  client: OrbotoClient,
  ticketKey: string,
): Promise<TicketRow> {
  const idx = ticketKey.indexOf('-');
  if (idx <= 0) {
    throw new Error(`Invalid ticket key "${ticketKey}" — expected format "PROJ-123".`);
  }
  const projectKey = ticketKey.slice(0, idx);
  const numberPart = ticketKey.slice(idx + 1);
  const project = await resolveProjectByKey(client, projectKey);
  try {
    return await client.get<TicketRow>(
      `/projects/${project.id}/tickets/by-key/${encodeURIComponent(numberPart)}`,
    );
  } catch (err) {
    if (err instanceof OrbotoApiError && err.status === 404) {
      throw new Error(`Ticket "${ticketKey}" not found in project "${project.key}".`);
    }
    throw err;
  }
}

/** Shorten a ticket row to the single-line summary used by list tools. */
export function ticketLine(t: TicketRow): string {
  const parts: string[] = [];
  if (t.ticketKey) parts.push(`[${t.ticketKey}]`);
  parts.push(t.title);
  parts.push(`(${t.statusName ?? t.status})`);
  if (t.priority && t.priority !== 'normal') parts.push(`<${t.priority}>`);
  if (t.assignees && t.assignees.length > 0) {
    parts.push(`→ ${t.assignees.map((a) => a.fullName || a.email).join(', ')}`);
  }
  // ORB-1605 — flag a ticket that's genuinely just waiting on stalled
  // commit/PR ingestion, not a ticket someone forgot to close.
  if (t.waitingForGitIngestion) parts.push('[waiting on Git ingestion]');
  return parts.join(' ');
}

// ---------------------------------------------------------------------------
// ORB-1252 / ORB-1283 / ORB-1609 - the agent-instance token.
//
// One MCP server process = one agent instance. Every surface that scopes work
// to an instance (timers, and since ORB-1609 work-session leases) MUST derive
// the token the same way, or the same agent ends up in two lanes: a claim
// starting a timer in lane A while its work session holds the lease in lane B
// is precisely the class of bug ORB-1603 had to paper over.
//
// A per-process random UUID rather than the PID: PIDs are recycled by the OS,
// so a fresh process could inherit a recycled PID and adopt a previous
// instance's stale timer or lease.
// ---------------------------------------------------------------------------
import { randomUUID } from 'node:crypto';

const MCP_PROCESS_INSTANCE = `mcp-${randomUUID()}`;

/** Precedence: explicit caller-supplied token > per-connection MCP session id
 *  (distinct per client even on a shared HTTP server) > per-process id (stdio). */
export function mcpInstanceToken(explicit?: string, extra?: { sessionId?: string }): string {
  return explicit ?? (extra?.sessionId ? `mcp-${extra.sessionId}` : MCP_PROCESS_INSTANCE);
}
