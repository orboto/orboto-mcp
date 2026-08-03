/**
 * ORB-916 — doc revision history MCP tools (epic ORB-911 Phase 5).
 *
 *   - orboto_list_doc_revisions   — GET /docs/:id/revisions  (cursor-paged)
 *   - orboto_get_doc_revision     — GET /docs/:id/revisions/:rid
 *   - orboto_restore_doc_revision — POST /docs/:id/revisions/:rid/restore
 *
 * Revisions are auto-captured by PATCH /docs/:id every time the title
 * or body changes, so by the time an agent wants to roll back there's
 * usually a long history to walk. The list endpoint is cursor-paged
 * (newest-first by editedAt DESC + id tiebreak) — the tool surfaces
 * `nextCursor` in structuredContent so the caller can page through if
 * the default 25-row page isn't enough.
 *
 * Restore writes a new revision capturing the current body before
 * rolling back, so the restore itself is also undoable.
 */
import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { OrbotoClient } from '../orboto-client.js';
import { resolveDocId } from './docs.js';

interface RevisionListRow {
  id: string;
  docId: string;
  title: string;
  editedBy: string | null;
  editedAt: string;
}
interface FullRevisionRow extends RevisionListRow {
  content: string;
}
interface RevisionPage {
  items: RevisionListRow[];
  nextCursor: string | null;
}
interface DocRow {
  id: string;
  spaceId: string;
  parentDocId: string | null;
  title: string;
  content: string;
  slug: string;
  visibility: string;
  icon: string | null;
  sortOrder: number;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// orboto_list_doc_revisions
// ---------------------------------------------------------------------------

export const listDocRevisionsToolConfig = {
  title: 'List the revision history of a doc page',
  description:
    'Return saved revisions for a doc page, newest-first. Each row carries the revision id, title at snapshot time, editor user id, and editedAt timestamp; the body content is NOT in this list (use orboto_get_doc_revision to fetch one). Cursor-paged — pass `cursor` to walk older pages.',
  inputSchema: z.object({
    docId: z.string().min(1).describe('Doc UUID or human-readable doc key (ORB-D12 / DOC-5).'),
    limit: z.number().int().min(1).max(100).optional().describe('Page size. Defaults to API default (25).'),
    cursor: z.string().optional().describe('Opaque cursor from a previous call\'s nextCursor.'),
  }).shape,
  annotations: { readOnlyHint: true, idempotentHint: true },
};

export function makeListDocRevisionsHandler(client: OrbotoClient) {
  return async ({ docId, limit, cursor }: {
    docId: string; limit?: number; cursor?: string;
  }): Promise<CallToolResult> => {
    docId = await resolveDocId(client, docId);
    const qs = new URLSearchParams();
    if (limit !== undefined) qs.set('limit', String(limit));
    if (cursor) qs.set('cursor', cursor);
    const query = qs.toString();
    const path = `/docs/${docId}/revisions${query ? `?${query}` : ''}`;
    const page = await client.get<RevisionPage>(path);
    if (page.items.length === 0) {
      return {
        content: [{ type: 'text', text: 'No revisions on this doc yet.' }],
        structuredContent: { revisions: [], nextCursor: null },
      };
    }
    const lines = page.items.map((r) => {
      const editor = r.editedBy ?? '(unknown)';
      return `- ${r.editedAt}  ·  ${r.title}  ·  by ${editor}  ·  id: ${r.id}`;
    });
    if (page.nextCursor) {
      lines.push('', `(more available — pass cursor: ${page.nextCursor})`);
    }
    return {
      content: [{ type: 'text', text: lines.join('\n') }],
      structuredContent: {
        revisions: page.items.map((r) => ({
          id: r.id,
          docId: r.docId,
          title: r.title,
          editedBy: r.editedBy,
          editedAt: r.editedAt,
        })),
        nextCursor: page.nextCursor,
      },
    };
  };
}

// ---------------------------------------------------------------------------
// orboto_get_doc_revision
// ---------------------------------------------------------------------------

export const getDocRevisionToolConfig = {
  title: 'Get a single doc revision',
  description:
    'Return the full content + title of one saved revision. Use this to diff against the current doc before deciding whether to restore.',
  inputSchema: z.object({
    docId: z.string().min(1).describe('Doc UUID or human-readable doc key (ORB-D12 / DOC-5).'),
    revisionId: z.string().uuid(),
  }).shape,
  annotations: { readOnlyHint: true, idempotentHint: true },
};

export function makeGetDocRevisionHandler(client: OrbotoClient) {
  return async ({ docId, revisionId }: {
    docId: string; revisionId: string;
  }): Promise<CallToolResult> => {
    docId = await resolveDocId(client, docId);
    const rev = await client.get<FullRevisionRow>(`/docs/${docId}/revisions/${revisionId}`);
    return {
      content: [{
        type: 'text',
        text: `# ${rev.title}\nRevision ${rev.id}  ·  editedAt: ${rev.editedAt}\n\n${rev.content || '_(empty)_'}`,
      }],
      structuredContent: {
        id: rev.id,
        docId: rev.docId,
        title: rev.title,
        content: rev.content,
        editedBy: rev.editedBy,
        editedAt: rev.editedAt,
      },
    };
  };
}

// ---------------------------------------------------------------------------
// orboto_restore_doc_revision
// ---------------------------------------------------------------------------

export const restoreDocRevisionToolConfig = {
  title: 'Restore a doc page to a saved revision',
  description:
    'Roll back the doc to the saved revision. The API snapshots the CURRENT body to a fresh revision row first, so the restore itself is also undoable. Returns the post-restore doc state.',
  inputSchema: z.object({
    docId: z.string().min(1).describe('Doc UUID or human-readable doc key (ORB-D12 / DOC-5).'),
    revisionId: z.string().uuid(),
  }).shape,
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
};

export function makeRestoreDocRevisionHandler(client: OrbotoClient) {
  return async ({ docId, revisionId }: {
    docId: string; revisionId: string;
  }): Promise<CallToolResult> => {
    docId = await resolveDocId(client, docId);
    const doc = await client.post<DocRow>(`/docs/${docId}/revisions/${revisionId}/restore`, {});
    return {
      content: [{
        type: 'text',
        text: `Restored doc ${doc.id} to revision ${revisionId}.\n  title: ${doc.title}\n  updatedAt: ${doc.updatedAt}`,
      }],
      structuredContent: {
        docId: doc.id,
        restoredFromRevisionId: revisionId,
        title: doc.title,
        updatedAt: doc.updatedAt,
      },
    };
  };
}
