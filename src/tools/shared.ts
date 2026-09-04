/**
 * ORB-244 Phase B - shared helpers for the read-tool suite.
 *
 * Every user-facing MCP tool takes **keys** where possible
 * (`ACME` for a project, `ACME-42` for a ticket) because that's what
 * the human typing in Claude knows. The API endpoints, by contrast,
 * take UUIDs for the cascade-friendly join path. These helpers do
 * the key→UUID resolution in one place.
 */
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { OrbotoApiError, type OrbotoClient } from '../orboto-client.js';

export interface ProjectRow {
  id: string;
  key: string;
  name: string;
  description: string | null;
  status: string;
  // ORB-994 - per-project content language, null = inherit workspace.
  language?: string | null;
  // ORB-1040 - RACI opt-in. Agents must not raise/set RACI unless true.
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
  /** ORB-1023 - resolved milestone name on enriched responses (by-id + lists);
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
  // ORB-1608 - role-aware commit policy (implementation/docs/review/admin/
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
  // ORB-1034 - full RACI roster (R/A/C/I). Present when the project has RACI
  // enabled; `assignees` above stays the Responsible+Accountable subset.
  raci?: Array<{ userId: string; email: string; fullName: string; role: 'R' | 'A' | 'C' | 'I' }>;
  labels?: Array<{ id: string; name: string }>;
  commentCount?: number;
  gitActivityCount?: number;
  checklistProgress?: { done: number; total: number };
  // ORB-1605 - in_review, zero ingested git_activities, but the project
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
 * Splits on the first `-` - project keys are upper-case alphanumerics
 * (max 20 chars) and never contain `-`, so the split is unambiguous.
 */
export async function resolveTicketByKey(
  client: OrbotoClient,
  ticketKey: string,
): Promise<TicketRow> {
  const idx = ticketKey.indexOf('-');
  if (idx <= 0) {
    throw new Error(`Invalid ticket key "${ticketKey}" - expected format "PROJ-123".`);
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
  // ORB-1605 - flag a ticket that's genuinely just waiting on stalled
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

/** ORB-1753 - the caller's self-declared agent profile from the process
 *  environment (stdio servers / runners). The api-key standing profile
 *  (ORB-1751) already covers keys server-side; these env vars let a
 *  keyless or per-process deployment declare without code. Explicit tool
 *  inputs override. */
export function envAgentProfile(): { agentKind?: string; modelTier?: string } {
  const kind = process.env.ORBOTO_AGENT_KIND?.trim().toLowerCase();
  const tier = process.env.ORBOTO_MODEL_TIER?.trim().toLowerCase();
  return { ...(kind ? { agentKind: kind } : {}), ...(tier ? { modelTier: tier } : {}) };
}

/** ORB-1753 - append the resolved profile to a querystring. */
export function applyAgentProfile(params: URLSearchParams, explicit?: { agentKind?: string; modelTier?: string }): void {
  const env = envAgentProfile();
  const kind = explicit?.agentKind ?? env.agentKind;
  const tier = explicit?.modelTier ?? env.modelTier;
  if (kind) params.set('agentKind', kind);
  if (tier) params.set('modelTier', tier);
}

// ---------------------------------------------------------------------------
// ORB-1819 - the writing-for-tokens size gate shared by the rule-block and
// primer-fact write tools. The backend body is
// `{ error, errorKey, errorParams, sizeWarning }`; this turns the hard-cap
// 422 into a clear, non-throwing tool result that tells the agent HOW to
// proceed (shorten it, or retry with allowOversize + oversizeReason) instead
// of letting the raw API error bubble up. Returns null if the error isn't
// this route's size-cap block (mirrors ticket-writes.ts's languageBlockResult).
// ---------------------------------------------------------------------------
interface SizeWarningLike { chars: number; limit: number; hint: string }

export function sizeBlockResult(err: unknown, verb: string): CallToolResult | null {
  if (!(err instanceof OrbotoApiError) || err.status !== 422) return null;
  let parsed: { error?: string; sizeWarning?: SizeWarningLike } = {};
  try { parsed = JSON.parse(err.body) as typeof parsed; } catch { /* non-JSON body */ }
  if (!parsed.sizeWarning) return null;
  const sw = parsed.sizeWarning;
  const text = `⛔ ${verb} blocked - content is ${sw.chars} characters, over the ${sw.limit}-character hard limit.\n` +
    `${sw.hint}\n` +
    `Only if you are sure the length is genuinely necessary, retry the same call with allowOversize=true and an oversizeReason (10+ characters explaining why).`;
  return {
    content: [{ type: 'text', text }],
    structuredContent: { blocked: true, sizeWarning: sw },
    isError: true,
  };
}

// ---------------------------------------------------------------------------
// ORB-1826 - shared name-matching normaliser for free-text milestone /
// label / status resolvers. An agent surface can hand back a name that
// differs from the canonical DB row only in mechanically-recoverable ways:
// leftover HTML entities from a rendering step upstream of the agent
// (`QA &amp; Testing`), a different case, or extra/collapsed whitespace.
// The workspace rule is normalise, never reject - if the canonical form is
// mechanically derivable, derive it instead of rejecting the call.
//
// Resolution order for every call site that uses `resolveByName`: raw exact
// match first (zero-cost, preserves today's behaviour for clean names),
// then a UNIQUE normalised match, then the existing ambiguity error listing
// the candidates.
//
// Twin: `apps/api/src/lib/name-normalize.ts` (same two functions, same
// semantics). This package ships standalone to npm with a deliberately
// minimal dependency set (MCP SDK + zod only) and does not depend on the
// API workspace package, so the ~20 lines below are duplicated rather than
// imported. The Go CLI (`cli/internal/cmd/normalize.go`) carries a third
// copy for the same reason. Keep all three in sync.
// ---------------------------------------------------------------------------

const NAMED_HTML_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
};

/** Decode the five XML-safe named entities plus numeric character
 *  references (`&#38;`, `&#x26;`). Intentionally NOT a general HTML
 *  decoder - just enough to undo a stray HTML-escaping step. */
export function decodeHtmlEntities(input: string): string {
  return input.replace(/&(#\d+|#x[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, entity: string) => {
    if (entity[0] === '#') {
      const isHex = entity[1] === 'x' || entity[1] === 'X';
      const codePoint = isHex ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
      return Number.isFinite(codePoint) && codePoint > 0 ? String.fromCodePoint(codePoint) : match;
    }
    const decoded = NAMED_HTML_ENTITIES[entity.toLowerCase()];
    return decoded ?? match;
  });
}

/** Canonical comparison key for a free-text name: HTML-entity-decoded,
 *  trimmed, internal whitespace collapsed to a single space, casefolded. */
export function normalizeName(input: string): string {
  return decodeHtmlEntities(input).trim().replace(/\s+/g, ' ').toLowerCase();
}

export interface NameMatchResult<T> {
  /** The single resolved candidate, or null (no match / ambiguous). */
  match: T | null;
  /** Set (length > 1) when more than one candidate normalises to the same
   *  key - the caller should surface all of them in the error. */
  ambiguous: T[] | null;
}

/**
 * Resolve `ref` against `candidates` by name: exact (raw) match wins
 * first; falls back to a unique normalised match. `ambiguous` is set
 * whenever more than one candidate ties at either stage.
 */
export function resolveByName<T>(
  candidates: T[],
  ref: string,
  getName: (item: T) => string,
): NameMatchResult<T> {
  const exactMatches = candidates.filter((c) => getName(c) === ref);
  if (exactMatches.length === 1) return { match: exactMatches[0], ambiguous: null };
  if (exactMatches.length > 1) return { match: null, ambiguous: exactMatches };

  const normalizedRef = normalizeName(ref);
  const normMatches = candidates.filter((c) => normalizeName(getName(c)) === normalizedRef);
  if (normMatches.length === 1) return { match: normMatches[0], ambiguous: null };
  if (normMatches.length > 1) return { match: null, ambiguous: normMatches };
  return { match: null, ambiguous: null };
}
