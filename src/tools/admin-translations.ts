/**
 * ORB-893 - admin-translation review queue MCP tools.
 *
 * Three thin wrappers around `/admin/tickets/translations*`:
 *
 * - `orboto_admin_translation_list` - paginated list of
 *    auto-translated tickets (pending review by default, or `all`).
 * - `orboto_admin_translation_approve` - stamp the row reviewed.
 * - `orboto_admin_translation_revert` - restore the pre-translation
 *    title + description from the audit comment.
 *
 * All three require `admin:translation_review` (super-admin holds it
 * by default).
 */
import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { OrbotoClient } from '../orboto-client.js';

interface TranslationRow {
  id: string;
  ticketKey: string | null;
  projectKey: string | null;
  projectId: string;
  title: string;
  autoTranslatedFrom: string;
  defaultLocale: string;
  reviewedAt: string | null;
  reviewedBy: { id: string; fullName: string | null; email: string } | null;
  createdAt: string | null;
  updatedAt: string;
}

interface ListResponse {
  items: TranslationRow[];
  nextCursor: string | null;
}

export const listAdminTranslationsToolConfig = {
  title: 'List auto-translated tickets for review',
  description:
    'List tickets the AI auto-translate flow rewrote, sorted newest-updated first. Default surface is the pending queue (tickets the admin has not yet approved). Pass `status: "all"` to include reviewed rows too. Returns up to `limit` (default 25) rows + a `nextCursor` for paging. Requires `admin:translation_review`.',
  inputSchema: z.object({
    status: z.enum(['pending', 'all']).optional().describe('Default: pending.'),
    limit: z.number().int().min(1).max(100).optional().describe('Default: 25.'),
    cursor: z.string().optional().describe('Opaque cursor from a previous response.'),
  }).shape,
  annotations: { readOnlyHint: true, idempotentHint: true },
};

export function makeListAdminTranslationsHandler(client: OrbotoClient) {
  return async ({ status, limit, cursor }: {
    status?: 'pending' | 'all';
    limit?: number;
    cursor?: string;
  }): Promise<CallToolResult> => {
    const qs = new URLSearchParams();
    if (status) qs.set('status', status);
    if (limit) qs.set('limit', String(limit));
    if (cursor) qs.set('cursor', cursor);
    const path = `/admin/tickets/translations${qs.toString() ? `?${qs.toString()}` : ''}`;
    const res = await client.get<ListResponse>(path);
    const lines = res.items.length === 0
      ? '(no auto-translated tickets)'
      : res.items.map((r) => {
        const reviewer = r.reviewedBy ? ` ✓ ${r.reviewedBy.fullName ?? r.reviewedBy.email}` : ' (pending review)';
        const key = r.ticketKey ?? r.id.slice(0, 8);
        return `- [${key}] ${r.title}  (${r.autoTranslatedFrom} → ${r.defaultLocale}${reviewer})`;
      }).join('\n');
    return {
      content: [{ type: 'text', text: lines + (res.nextCursor ? `\n\n(next cursor: ${res.nextCursor})` : '') }],
      structuredContent: { items: res.items, nextCursor: res.nextCursor },
    };
  };
}

export const approveTranslationToolConfig = {
  title: 'Approve an auto-translated ticket',
  description:
    'Stamp `translation_reviewed_at` + `translation_reviewed_by` on a ticket the AI auto-translate flow rewrote. Idempotent - re-approving the same row simply refreshes the timestamp + reviewer. 409 if the ticket was never auto-translated. Requires `admin:translation_review`.',
  inputSchema: z.object({
    ticketId: z.string().uuid().describe('UUID of the ticket to approve.'),
  }).shape,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
};

export function makeApproveTranslationHandler(client: OrbotoClient) {
  return async ({ ticketId }: { ticketId: string }): Promise<CallToolResult> => {
    const res = await client.post<{ id: string; reviewedAt: string; reviewedBy: string }>(
      `/admin/tickets/${ticketId}/translations/approve`,
      {},
    );
    return {
      content: [{ type: 'text', text: `Approved translation for ticket ${ticketId} at ${res.reviewedAt}.` }],
      structuredContent: res,
    };
  };
}

export const revertTranslationToolConfig = {
  title: 'Revert an auto-translated ticket back to the original',
  description:
    'Restore the pre-translation title + description from the auto-translated audit comment and clear the auto-translate marker + any prior approval. Use when the AI got the translation wrong and the operator wants to start over. 409 if the ticket was never auto-translated. Requires `admin:translation_review`.',
  inputSchema: z.object({
    ticketId: z.string().uuid().describe('UUID of the ticket to revert.'),
  }).shape,
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
};

export function makeAdminRevertTranslationHandler(client: OrbotoClient) {
  return async ({ ticketId }: { ticketId: string }): Promise<CallToolResult> => {
    const res = await client.post<{ id: string; title: string; description: string | null }>(
      `/admin/tickets/${ticketId}/translations/revert`,
      {},
    );
    return {
      content: [{ type: 'text', text: `Reverted ticket ${ticketId} to its original content.` }],
      structuredContent: res,
    };
  };
}
