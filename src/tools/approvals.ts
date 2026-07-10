/**
 * ORB-1223 - approval / sign-off gate tools.
 *
 *   - orboto_list_approvals   - list a ticket's approval / sign-off requests.
 *   - orboto_approval_decide  - cast an approve/reject vote on a pending request.
 *
 * Policy configuration stays out of the MCP surface (admin config, like the
 * other project-settings surfaces the agent tools deliberately don't expose).
 */
import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { type OrbotoClient } from '../orboto-client.js';
import { resolveTicketByKey, type TicketRow } from './shared.js';

interface ApprovalRequestSummary {
  id: string;
  toStatusName: string;
  policyName: string;
  mode: string;
  status: string;
  requiredApprovals: number;
  currentStep: number;
  approveCount: number;
  rejectCount: number;
  requestedBy: string | null;
  canApprove?: boolean;
  votes: Array<{ voterId: string; decision: string; comment: string | null }>;
}

function fmt(r: ApprovalRequestSummary): string {
  return `  ${r.id} → "${r.toStatusName}" [${r.status}] ${r.approveCount}/${r.requiredApprovals} approvals (${r.policyName})${r.canApprove ? ' - you can vote' : ''}`;
}

// ---------------------------------------------------------------------------
// orboto_list_approvals
// ---------------------------------------------------------------------------

export const listApprovalsToolConfig = {
  title: 'List a ticket\'s approval / sign-off requests',
  description:
    'List the approval / sign-off requests on a ticket (generic change-management gates on status transitions). Shows each request\'s target status, mode, approval progress, and whether YOU can vote on it right now. Use this before `orboto_approval_decide`.',
  inputSchema: z.object({
    ticketKey: z.string().min(3).describe('Ticket key, e.g. ORB-42.'),
  }).shape,
};

export function makeListApprovalsHandler(client: OrbotoClient) {
  return async ({ ticketKey }: { ticketKey: string }): Promise<CallToolResult> => {
    const ticket = await resolveTicketByKey(client, ticketKey) as TicketRow;
    const rows = await client.get<ApprovalRequestSummary[]>(
      `/projects/${ticket.projectId}/tickets/${ticket.id}/approval-requests`,
    );
    const text = rows.length === 0
      ? `No approval requests on [${ticket.ticketKey}].`
      : `Approval requests on [${ticket.ticketKey}]:\n${rows.map(fmt).join('\n')}`;
    return { content: [{ type: 'text', text }], structuredContent: { ticketKey: ticket.ticketKey, requests: rows } };
  };
}

// ---------------------------------------------------------------------------
// orboto_approval_decide
// ---------------------------------------------------------------------------

export const approvalDecideToolConfig = {
  title: 'Approve or reject a ticket sign-off request',
  description:
    'Cast an approve/reject vote on a pending approval / sign-off request that gates a ticket status transition. You must be an eligible approver (a policy role, a named user, or a RACI role on the ticket) - otherwise the API returns 403. A single reject resolves the request; enough approvals unblock the transition (the requester then re-applies the status move). If the ticket has several pending requests, pass `requestId`.',
  inputSchema: z.object({
    ticketKey: z.string().min(3).describe('Ticket key, e.g. ORB-42.'),
    decision: z.enum(['approve', 'reject']).describe('Your decision.'),
    comment: z.string().optional().describe('Optional decision comment (recorded on the vote + notified to the requester).'),
    requestId: z.string().uuid().optional().describe('Disambiguate when the ticket has more than one pending request.'),
  }).shape,
};

export function makeApprovalDecideHandler(client: OrbotoClient) {
  return async ({ ticketKey, decision, comment, requestId }: {
    ticketKey: string; decision: 'approve' | 'reject'; comment?: string; requestId?: string;
  }): Promise<CallToolResult> => {
    const ticket = await resolveTicketByKey(client, ticketKey) as TicketRow;
    const rows = await client.get<ApprovalRequestSummary[]>(
      `/projects/${ticket.projectId}/tickets/${ticket.id}/approval-requests`,
    );
    const pending = rows.filter((r) => r.status === 'pending');
    let target = requestId ? pending.find((r) => r.id === requestId) : pending.find((r) => r.canApprove) ?? pending[0];
    if (!target) {
      throw new Error(`No pending approval request to decide on [${ticket.ticketKey}]${requestId ? ` (requestId ${requestId} not pending)` : ''}.`);
    }
    const updated = await client.post<ApprovalRequestSummary>(
      `/projects/${ticket.projectId}/approval-requests/${target.id}/decision`,
      { decision, comment: comment ?? null },
    );
    return {
      content: [{
        type: 'text',
        text: `Recorded ${decision} on request for "${updated.toStatusName}" - now ${updated.status} (${updated.approveCount}/${updated.requiredApprovals}).`,
      }],
      structuredContent: { ticketKey: ticket.ticketKey, request: updated },
    };
  };
}
