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
  checklistProgress?: { done: number; total: number };
  // ORB-1605 — in_review, zero ingested git_activities, but the project
  // HAS an active git connection: closing verification may be blocked
  // on stalled commit/PR ingestion rather than genuinely unlinked work.
  // Absent (not false) on responses the enrich pipeline didn't touch.
  waitingForGitIngestion?: boolean;
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
