/**
 * ORB-1615 - structural review policy tools.
 *
 *   - orboto_review_fingerprint     - normalize + hash raw diff text into a
 *                                     canonical fingerprint (+ real size
 *                                     metrics), server-side (one algorithm,
 *                                     not one per client).
 *   - orboto_review_policy_check    - the consult-before-invoking-a-model
 *     call: what risk level does this ticket carry, and (if a fingerprint
 *     is supplied) is there already a valid approval for THIS exact diff.
 *   - orboto_review_approval_record - record an approve/reject decision
 *     against a ticket's diff fingerprint.
 *
 * Rule CONFIGURATION (path pattern / deliveryMode / size -> risk level)
 * stays out of the MCP surface, same call as approval_policies' CRUD in
 * tools/approvals.ts: it's project-settings admin config, not something an
 * autonomous agent tool should expose.
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

// ---------------------------------------------------------------------------
// orboto_review_fingerprint
// ---------------------------------------------------------------------------

export const reviewFingerprintToolConfig = {
  title: 'Compute a canonical diff fingerprint',
  description:
    'Normalize + hash raw diff text (e.g. `git diff` output) into a canonical fingerprint, server-side - so every agent hashes the same way instead of each fudging its own. Whitespace-only / blank-line-only edits and file ORDER are invisible to the hash (an approval survives a reflow); any real content change, a permission/mode change, or an added/removed/renamed file is NOT (an approval never survives those). Also returns real size metrics (filesChanged/linesAdded/linesRemoved/paths) derived from the same diff. Use the returned `fingerprint` with `orboto_review_policy_check` and `orboto_review_approval_record`.',
  inputSchema: z.object({
    diff: z.string().min(1).describe('Raw unified diff text, e.g. the output of `git diff` / `git diff --no-color`.'),
  }).shape,
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

// ---------------------------------------------------------------------------
// orboto_review_policy_check
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// orboto_review_approval_record
// ---------------------------------------------------------------------------

export const reviewApprovalRecordToolConfig = {
  title: 'Record a review approve/reject decision against a diff fingerprint',
  description:
    'Record your review verdict (approve/reject) against a ticket\'s diff fingerprint (from orboto_review_fingerprint). A recorded APPROVAL is reusable: orboto_review_policy_check reports it as valid for the SAME fingerprint, letting a later finish/close skip re-review - until the diff changes, which produces a different fingerprint and naturally stops matching. Requires ticket:record_review_approval.',
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
