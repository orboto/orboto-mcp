/**
 * ORB-1609 / ORB-1613 - the wire shapes the work-session tools share:
 * resource claims, the start bundle `orboto_work_start` and
 * `orboto_work_next` both return, and the git-health reason texts.
 * Extracted so `orboto_work_next` can live in its own module (file-size
 * ratchet, ORB-1863) without a cycle back into work-sessions.ts.
 */
import { z } from 'zod';

/** ORB-1610 - `state`/`requestedAt` are optional in the wire shape only
 *  for backwards compatibility with pre-ORB-1610 rows; every claim this
 *  tool sends or reads going forward carries both. */
export interface ResourceClaim {
  kind: 'path' | 'named';
  value: string;
  mode: 'read' | 'write';
  state?: 'granted' | 'waiting';
  requestedAt?: string;
}

export interface WorkSessionRow {
  id: string;
  ticketId: string;
  role: string;
  status: string;
  startedAt: string;
  leaseUntil: string;
  activeTimerId: string | null;
  commitSha: string | null;
  commitVerified?: boolean;
  resourceClaims?: ResourceClaim[];
  ticketKey?: string | null;
  ticketTitle?: string | null;
  projectKey?: string | null;
  userEmail?: string | null;
  userFullName?: string | null;
}

export interface LeaseHolder {
  sessionId: string;
  userEmail: string | null;
  userFullName: string | null;
  role: string;
  startedAt: string;
  leaseUntil: string;
}

export interface ClaimHolderInfo {
  sessionId: string;
  ticketKey: string | null;
  userEmail: string | null;
  userFullName: string | null;
  claim: ResourceClaim;
}

export interface ClaimConflict {
  claim: ResourceClaim;
  holders: ClaimHolderInfo[];
}

export interface QueuedClaimResult {
  claim: ResourceClaim;
  position: number;
  blockedBy: ClaimHolderInfo[];
}

export const ResourceClaimShape = {
  kind: z.enum(['path', 'named']),
  value: z.string().min(1).max(500),
  mode: z.enum(['read', 'write']),
};

/** Shared 409-body reader: the endpoint's body carries EITHER `holder`
 *  (a lease conflict) OR `claimConflicts` (a resource-claim conflict) -
 *  never both, since the lease is checked before claims are applied. */
export { GIT_HEALTH_REASON_TEXT } from './git-health-reasons.js';

export interface GitConnectionHealth {
  connectionId: string;
  name: string;
  provider: string;
  connected: boolean;
  healthy: boolean;
  lastEventAt: string | null;
  reason: string | null;
}

export interface StartTicket {
  ticketKey: string | null;
  title: string;
  description?: string | null;
  status?: string;
  statusName?: string;
  priority: string;
  type: string;
}

export interface StartChecklistItem {
  content: string;
  effectiveCompleted: boolean;
  linkedTicketKey: string | null;
  linkedTicketStatusCategory: string | null;
}

export interface StartChecklist {
  title: string;
  triggersDone: boolean;
  progress: { done: number; total: number };
  items: StartChecklistItem[];
}

export interface StartDependencyEdge {
  ticketKey: string | null;
  // ORB-1614 - null on an opaque cross-project stub the caller cannot
  // read (see `external`/`resolved`).
  title: string | null;
  statusName: string | null;
  external?: boolean;
  resolved?: boolean;
}

export interface StartBundleResponse {
  session: WorkSessionRow;
  reused: boolean;
  displaced?: LeaseHolder;
  queued?: QueuedClaimResult[];
  rulesHash: string;
  rulesUnchanged: boolean;
  rules?: string;
  primer: { markdown: string; totalTokens: number };
  ticket: StartTicket;
  checklists: StartChecklist[];
  dependencies: { blockedBy: StartDependencyEdge[]; blocks: StartDependencyEdge[] };
  gitHealth: GitConnectionHealth[];
  siblingSessions: WorkSessionRow[];
}
