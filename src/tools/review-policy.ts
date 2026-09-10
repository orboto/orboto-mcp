/**
 * ORB-1615 - structural review policy tools.
 */
import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { type OrbotoClient } from '../orboto-client.js';
import { resolveTicketByKey, type TicketRow } from './shared.js';

interface DiffFingerprintResult {
  fingerprint: string;
  algo: string;
  filesChanged: number;
  linesAdded: number;
  linesRemoved: number;
  paths: string[];
}

interface ReviewApproval {
  id: string;
  ticketId: string;
  fingerprint: string;
  decision: 'approved' | 'rejected';
  reviewerLabel: string | null;
  note: string | null;
  revokedAt: string | null;
  createdAt: string;
}

interface ReviewPolicyDecision {
  riskLevel: 'none' | 'on_request' | 'required';
  source: 'ticket_override' | 'rule' | 'default' | 'fail_safe';
  matchedRuleName: string | null;
  evaluationError: string | null;
  fingerprintChecked: boolean;
  hasValidApproval: boolean;
  latestApproval: ReviewApproval | null;
}

export const reviewFingerprintToolConfig = {
  title: 'Compute a canonical diff fingerprint',
  description:
    'Hash the exact submitted diff text server-side with sha256-diff-v2. Every text change, including indentation, blank lines, binary blob identities, mode/rename metadata and file order, changes the fingerprint. This is submitted-text identity, NOT independent repository attestation. Returns size/path metrics too. Preserve the complete opaque version-prefixed `fingerprint` for `orboto_review_policy_check` and `orboto_review_approval_record`; legacy v1 approvals remain history only and must be reviewed again.',
  inputSchema: z.object({
    diff: z.string().min(1).describe('Raw unified diff text, e.g. the output of `git diff` / `git diff --no-color`.'),
  }).shape,
  annotations: { readOnlyHint: true, idempotentHint: true },
};

export function makeReviewFingerprintHandler(client: OrbotoClient) {
  return async ({ diff }: { diff: string }): Promise<CallToolResult> => {
    const result = await client.post<DiffFingerprintResult>('/review-policy/fingerprint', { diff });
    return {
      content: [{
        type: 'text',
        text: `Fingerprint ${result.fingerprint} (${result.algo}) - ${result.filesChanged} file(s), +${result.linesAdded}/-${result.linesRemoved}.`,
      }],
      structuredContent: result as unknown as Record<string, unknown>,
    };
  };
}

export const reviewPolicyCheckToolConfig = {
  title: 'Check a ticket\'s review policy before invoking a reviewer',
  description:
    'Consult a ticket\'s structural review policy BEFORE spawning a review session or invoking a model. Called with no diff context (the common case, right after picking up a ticket) it resolves the per-ticket override or a deliveryMode-only rule; passing `paths`/`linesChanged` (from `orboto_review_fingerprint`) additionally matches path/size-scoped rules and, if `fingerprint` is passed too, checks whether a VALID approval already covers this exact diff - so a low-risk ticket, or one already reviewed at this fingerprint, can close without spawning a reviewer. `riskLevel: "required"` with `source: "fail_safe"` means the policy engine itself errored - treat that as "review required", never as "no review needed".',
  inputSchema: z.object({
    ticketKey: z.string().min(3).describe('Ticket key, e.g. ORB-42.'),
    fingerprint: z.string().min(8).optional().describe('From orboto_review_fingerprint - checks for an existing valid approval at this exact diff.'),
    paths: z.array(z.string()).max(500).optional().describe('Changed file paths (from orboto_review_fingerprint) - refines the match against path-scoped rules.'),
    linesChanged: z.number().int().nonnegative().optional().describe('Total changed lines (linesAdded + linesRemoved) - refines the match against size-scoped rules.'),
  }).shape,
  annotations: { readOnlyHint: true, idempotentHint: true },
};

export function makeReviewPolicyCheckHandler(client: OrbotoClient) {
  return async (
    { ticketKey, fingerprint, paths, linesChanged }: { ticketKey: string; fingerprint?: string; paths?: string[]; linesChanged?: number },
  ): Promise<CallToolResult> => {
    const ticket = await resolveTicketByKey(client, ticketKey) as TicketRow;
    const decision = await client.post<ReviewPolicyDecision>(
      `/projects/${ticket.projectId}/tickets/${ticket.id}/review-policy/check`,
      { fingerprint, paths, linesChanged },
    );
    const parts = [`[${ticket.ticketKey}] review risk: ${decision.riskLevel} (${decision.source}${decision.matchedRuleName ? `: "${decision.matchedRuleName}"` : ''}).`];
    if (decision.evaluationError) parts.push(`Policy engine error - treat as required: ${decision.evaluationError}`);
    if (decision.fingerprintChecked) {
      parts.push(decision.hasValidApproval ? 'A valid approval already covers this exact diff.' : 'No valid approval for this diff - the fingerprint changed or none was recorded.');
    }
    return {
      content: [{ type: 'text', text: parts.join(' ') }],
      structuredContent: { ticketKey: ticket.ticketKey, ...decision } as unknown as Record<string, unknown>,
    };
  };
}

export const reviewApprovalRecordToolConfig = {
  title: 'Record a review decision against a diff fingerprint',
  description:
    'Record your review verdict (approve/reject) against the complete version-prefixed fingerprint from orboto_review_fingerprint. A current-algorithm approval is reusable only for identical submitted diff text; even whitespace or file-order changes require a fresh review. Legacy/unversioned records remain history only. This advisory review ledger does not itself enforce ticket closure. Requires ticket:record_review_approval.',
  inputSchema: z.object({
    ticketKey: z.string().min(3).describe('Ticket key, e.g. ORB-42.'),
    fingerprint: z.string().min(8).describe('From orboto_review_fingerprint.'),
    decision: z.enum(['approved', 'rejected']).describe('Your review verdict.'),
    note: z.string().max(2000).optional().describe('Optional review comment.'),
    filesChanged: z.number().int().nonnegative().optional(),
    linesAdded: z.number().int().nonnegative().optional(),
    linesRemoved: z.number().int().nonnegative().optional(),
    paths: z.array(z.string()).max(500).optional(),
  }).shape,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
};

export function makeReviewApprovalRecordHandler(client: OrbotoClient) {
  return async (args: {
    ticketKey: string; fingerprint: string; decision: 'approved' | 'rejected'; note?: string;
    filesChanged?: number; linesAdded?: number; linesRemoved?: number; paths?: string[];
  }): Promise<CallToolResult> => {
    const ticket = await resolveTicketByKey(client, args.ticketKey) as TicketRow;
    const { ticketKey: _ticketKey, ...body } = args;
    const approval = await client.post<ReviewApproval>(
      `/projects/${ticket.projectId}/tickets/${ticket.id}/review-approvals`,
      body,
    );
    return {
      content: [{
        type: 'text',
        text: `Recorded ${approval.decision} on [${ticket.ticketKey}] for fingerprint ${approval.fingerprint}.`,
      }],
      structuredContent: { ticketKey: ticket.ticketKey, approval: approval as unknown as Record<string, unknown> },
    };
  };
}
