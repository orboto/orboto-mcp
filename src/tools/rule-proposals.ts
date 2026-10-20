/**
 * ORB-2579 - rule proposals: an agent proposes a behaviour rule, a person with rule rights accepts or rejects it.
 */
import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { OrbotoClient } from '../orboto-client.js';
import { sizeBlockResult } from './shared.js';

interface Duplicate { kind: 'rule' | 'proposal'; id: string; title: string; exact: boolean }
interface ProposalRow {
  id: string; scope: string; projectKey: string | null; title: string; status: string;
  duplicates: Duplicate[]; proposedByName: string | null; decisionReason: string | null; canDecide: boolean;
  sizeWarning?: { chars: number; limit: number; hint: string };
}

const SCOPES = ['workspace', 'customer', 'project', 'personal'] as const;

function duplicateLines(row: ProposalRow): string {
  return row.duplicates.map((d) => `\n  ${d.exact ? 'exact' : 'text'} match: ${d.kind} "${d.title}" (${d.id})`).join('');
}

function scopeLabel(row: ProposalRow): string {
  return row.projectKey ? `${row.scope} ${row.projectKey}` : row.scope;
}

export const ruleProposeToolConfig = {
  title: 'Propose a behaviour rule',
  description: 'Propose a behaviour rule for a person to accept. It binds only once a person with rule rights accepts it, and the decision comes back as agent mail; overlapping rules are named as text matches. Title: one imperative sentence; body <= 400 chars, Rule / Why / How.',
  inputSchema: z.object({
    title: z.string().min(1).max(120),
    body: z.string().min(1).max(8000),
    scope: z.enum(SCOPES).default('workspace'),
    projectKey: z.string().min(1).max(32).optional(),
    customerId: z.string().uuid().optional(),
    reason: z.string().min(1).max(1000).optional(),
    allowOversize: z.boolean().optional(),
    oversizeReason: z.string().min(10).max(500).optional(),
  }).shape,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
};

export function makeRuleProposeHandler(client: OrbotoClient) {
  return async (input: {
    title: string; body: string; scope?: string; projectKey?: string; customerId?: string; reason?: string;
    allowOversize?: boolean; oversizeReason?: string;
  }): Promise<CallToolResult> => {
    let row: ProposalRow;
    try {
      row = await client.post<ProposalRow>('/agent-instructions/proposals', { ...input, scope: input.scope ?? 'workspace' });
    } catch (err) {
      const blocked = sizeBlockResult(err, 'Rule proposal');
      if (blocked) return blocked;
      throw err;
    }
    const warn = row.sizeWarning ? `\nBody is over the ${row.sizeWarning.limit}-char soft limit. ${row.sizeWarning.hint}` : '';
    return {
      content: [{ type: 'text', text: `Proposed rule "${row.title}" (${scopeLabel(row)}, id ${row.id}), pending review by a person with rule rights.${duplicateLines(row)}${warn}` }],
      structuredContent: row as unknown as Record<string, unknown>,
    };
  };
}

export const ruleProposalsToolConfig = {
  title: 'List rule proposals',
  description: 'List rule proposals. Your own plus the queue you may see, newest first; canDecide marks what you may accept or reject (a person with rule rights: orboto_rule_proposal_accept, orboto_rule_proposal_reject).',
  inputSchema: z.object({
    status: z.enum(['pending', 'accepted', 'rejected', 'all']).default('pending'),
    scope: z.enum(SCOPES).optional(),
    projectId: z.string().uuid().optional(),
    customerId: z.string().uuid().optional(),
    mine: z.boolean().optional(),
    limit: z.number().int().min(1).max(100).optional(),
    cursor: z.string().optional(),
  }).shape,
  annotations: { readOnlyHint: true, idempotentHint: true },
};

export function makeRuleProposalsHandler(client: OrbotoClient) {
  return async (input: { status?: string; scope?: string; projectId?: string; customerId?: string; mine?: boolean; limit?: number; cursor?: string } = {}): Promise<CallToolResult> => {
    const p = new URLSearchParams({ status: input.status ?? 'pending' });
    if (input.scope) p.set('scope', input.scope);
    if (input.projectId) p.set('projectId', input.projectId);
    if (input.customerId) p.set('customerId', input.customerId);
    if (input.mine !== undefined) p.set('mine', String(input.mine));
    if (input.limit !== undefined) p.set('limit', String(input.limit));
    if (input.cursor) p.set('cursor', input.cursor);
    const page = await client.get<{ items: ProposalRow[]; nextCursor: string | null }>(`/agent-instructions/proposals?${p.toString()}`);
    const lines = page.items.map((r) => `- [${r.status}] ${r.title} (${scopeLabel(r)}, id ${r.id}, by ${r.proposedByName ?? 'unknown'})${r.canDecide ? ' [you can decide]' : ''}${r.decisionReason ? `\n  reason: ${r.decisionReason}` : ''}${duplicateLines(r)}`);
    return {
      content: [{ type: 'text', text: (lines.length ? lines.join('\n') : 'No rule proposals.') + (page.nextCursor ? `\nMore: cursor ${page.nextCursor}` : '') }],
      structuredContent: page as unknown as Record<string, unknown>,
    };
  };
}

interface Decision { proposal: ProposalRow & { acceptedEdited?: boolean }; block: { id: string } | null; proposerNotified: boolean }

function decisionText(verb: string, res: Decision): string {
  const block = res.block ? ` as rule block ${res.block.id}${res.proposal.acceptedEdited ? ' (edited)' : ''}` : '';
  return `${verb} rule proposal "${res.proposal.title}"${block}; ${res.proposerNotified ? 'the proposer got the decision as agent mail' : 'no agent mail was sent'}.`;
}

export const ruleProposalAcceptToolConfig = {
  title: 'Accept a rule proposal',
  description: 'Accept a pending rule proposal as a rule block, as proposed or edited. A person with rule rights on its scope only, on the explicit instruction of that person; a bot account or an agent key gets 403 errors.agent_rules.review_needs_person. must-read stays off unless set.',
  inputSchema: z.object({
    proposalId: z.string().uuid(),
    title: z.string().min(1).max(120).optional(),
    body: z.string().min(1).max(8000).optional(),
    mustRead: z.boolean().optional(),
    note: z.string().min(1).max(1000).optional(),
    allowOversize: z.boolean().optional(),
    oversizeReason: z.string().min(10).max(500).optional(),
  }).shape,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
};

export function makeRuleProposalAcceptHandler(client: OrbotoClient) {
  return async ({ proposalId, ...body }: {
    proposalId: string; title?: string; body?: string; mustRead?: boolean; note?: string; allowOversize?: boolean; oversizeReason?: string;
  }): Promise<CallToolResult> => {
    let res: Decision;
    try {
      res = await client.post<Decision>(`/agent-instructions/proposals/${encodeURIComponent(proposalId)}/accept`, body);
    } catch (err) {
      const blocked = sizeBlockResult(err, 'Rule proposal accept');
      if (blocked) return blocked;
      throw err;
    }
    return { content: [{ type: 'text', text: decisionText('Accepted', res) }], structuredContent: res as unknown as Record<string, unknown> };
  };
}

export const ruleProposalRejectToolConfig = {
  title: 'Reject a rule proposal',
  description: 'Reject a pending rule proposal with a reason the proposer receives. A person with rule rights on its scope only, on the explicit instruction of that person; a bot account or an agent key gets 403 errors.agent_rules.review_needs_person.',
  inputSchema: z.object({
    proposalId: z.string().uuid(),
    reason: z.string().min(3).max(1000),
  }).shape,
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
};

export function makeRuleProposalRejectHandler(client: OrbotoClient) {
  return async ({ proposalId, reason }: { proposalId: string; reason: string }): Promise<CallToolResult> => {
    const res = await client.post<Decision>(`/agent-instructions/proposals/${encodeURIComponent(proposalId)}/reject`, { reason });
    return { content: [{ type: 'text', text: decisionText('Rejected', res) }], structuredContent: res as unknown as Record<string, unknown> };
  };
}
