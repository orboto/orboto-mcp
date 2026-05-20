/**
 * ORB-917 — doc-comments MCP tools (epic ORB-911 Phase 6).
 *
 *   - orboto_list_doc_comments      — GET /docs/:id/comments  (cursor-paged, oldest-first)
 *   - orboto_post_doc_comment       — POST /docs/:id/comments
 *   - orboto_resolve_doc_comment    — POST /docs/:id/comments/:cid/resolve
 *   - orboto_delete_doc_comment     — DELETE /docs/:id/comments/:cid
 *
 * Comments support replies (single-level — replying to a reply lands as
 * a sibling of the original reply because the API auto-flattens past
 * one level) and optional anchors (a 3-tuple of {text, before, after}
 * the frontend uses to re-locate a highlight even after the doc body
 * has shifted).
 *
 * resolve acts on the thread root by design so resolving from a reply
 * folds the whole conversation — mirrors the web UI's behaviour.
 */
import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { OrbotoClient } from '../orboto-client.js';

interface DocCommentRow {
  id: string;
  docId: string;
  userId: string;
  parentCommentId: string | null;
  content: string;
  anchor: { text: string; before: string; after: string } | null;
  resolvedAt: string | null;
  resolvedBy: string | null;
  createdAt: string;
  userName?: string | null;
  userAvatarUrl?: string | null;
  resolvedByName?: string | null;
}

interface CommentPage {
  items: DocCommentRow[];
  nextCursor: string | null;
}

// ---------------------------------------------------------------------------
// orboto_list_doc_comments
// ---------------------------------------------------------------------------

export const listDocCommentsToolConfig = {
  title: 'List comments on a doc page',
  description:
    'Return comments on a doc page, oldest-first so the reply tree reads top-to-bottom. Each row carries the author name + content + resolved state. Cursor-paged — pass `cursor` from the previous call\'s nextCursor to walk older pages.',
  inputSchema: z.object({
    docId: z.string().uuid(),
    limit: z.number().int().min(1).max(100).optional(),
    cursor: z.string().optional(),
  }).shape,
  annotations: { readOnlyHint: true, idempotentHint: true },
};

export function makeListDocCommentsHandler(client: OrbotoClient) {
  return async ({ docId, limit, cursor }: {
    docId: string; limit?: number; cursor?: string;
  }): Promise<CallToolResult> => {
    const qs = new URLSearchParams();
    if (limit !== undefined) qs.set('limit', String(limit));
    if (cursor) qs.set('cursor', cursor);
    const query = qs.toString();
    const page = await client.get<CommentPage>(`/docs/${docId}/comments${query ? `?${query}` : ''}`);

    if (page.items.length === 0) {
      return {
        content: [{ type: 'text', text: 'No comments on this doc.' }],
        structuredContent: { comments: [], nextCursor: null },
      };
    }

    // Build a parent-keyed tree so the Markdown rendering can indent
    // replies one level under their root. The API already flattens
    // past one level, so depth is always 0 or 1.
    const byParent = new Map<string | null, DocCommentRow[]>();
    for (const c of page.items) {
      const key = c.parentCommentId ?? null;
      const arr = byParent.get(key) ?? [];
      arr.push(c);
      byParent.set(key, arr);
    }

    const lines: string[] = [];
    const renderOne = (c: DocCommentRow, depth: number): void => {
      const indent = '  '.repeat(depth);
      const author = c.userName ?? `user ${c.userId.slice(0, 8)}`;
      const resolved = c.resolvedAt ? ' [resolved]' : '';
      lines.push(`${indent}- ${author}  ·  ${c.createdAt}${resolved}  ·  id: ${c.id}`);
      // Anchor preview helps the model understand what part of the
      // doc the comment is anchored to. Truncate to keep the output
      // compact.
      if (c.anchor) {
        const snippet = c.anchor.text.length > 80 ? c.anchor.text.slice(0, 77) + '...' : c.anchor.text;
        lines.push(`${indent}  anchored on: "${snippet}"`);
      }
      const body = c.content.split('\n').map((l) => `${indent}  ${l}`).join('\n');
      lines.push(body);
      // Render direct replies one level deeper.
      const replies = byParent.get(c.id) ?? [];
      for (const r of replies) renderOne(r, depth + 1);
    };
    for (const root of byParent.get(null) ?? []) {
      renderOne(root, 0);
      lines.push(''); // blank line between root threads
    }
    if (page.nextCursor) {
      lines.push(`(more available — pass cursor: ${page.nextCursor})`);
    }
    return {
      content: [{ type: 'text', text: lines.join('\n').trimEnd() }],
      structuredContent: {
        comments: page.items.map((c) => ({
          id: c.id,
          docId: c.docId,
          userId: c.userId,
          userName: c.userName,
          parentCommentId: c.parentCommentId,
          content: c.content,
          anchor: c.anchor,
          resolvedAt: c.resolvedAt,
          resolvedBy: c.resolvedBy,
          resolvedByName: c.resolvedByName,
          createdAt: c.createdAt,
        })),
        nextCursor: page.nextCursor,
      },
    };
  };
}

// ---------------------------------------------------------------------------
// orboto_post_doc_comment
// ---------------------------------------------------------------------------

export const postDocCommentToolConfig = {
  title: 'Post a comment on a doc page (or reply to one)',
  description:
    'Add a comment to a doc page. Pass `parentCommentId` to reply (the API flattens reply chains past one level so a reply-of-reply lands as a sibling of the original reply). Optional `anchor` (`{text, before, after}`) attaches the comment to a specific highlight in the body — the frontend uses the surrounding context to re-locate the anchor even after the doc has been edited. Mentions in the content body (`@username`) fire notifications automatically.',
  inputSchema: z.object({
    docId: z.string().uuid(),
    content: z.string().min(1).max(4000),
    parentCommentId: z.string().uuid().optional().describe('Reply to an existing comment.'),
    anchor: z.object({
      text: z.string().min(1).max(400).describe('The highlighted body text the comment is anchored to.'),
      before: z.string().max(80).describe('Characters before the highlight, for anchor re-discovery.'),
      after: z.string().max(80).describe('Characters after the highlight, for anchor re-discovery.'),
    }).optional(),
  }).shape,
};

export function makePostDocCommentHandler(client: OrbotoClient) {
  return async ({ docId, content, parentCommentId, anchor }: {
    docId: string; content: string; parentCommentId?: string;
    anchor?: { text: string; before: string; after: string };
  }): Promise<CallToolResult> => {
    const body: Record<string, unknown> = { content };
    if (parentCommentId) body.parentCommentId = parentCommentId;
    if (anchor) body.anchor = anchor;
    const row = await client.post<DocCommentRow>(`/docs/${docId}/comments`, body);
    return {
      content: [{
        type: 'text',
        text: `Posted comment ${row.id} on doc ${docId}${row.parentCommentId ? ` (reply to ${row.parentCommentId})` : ''}.`,
      }],
      structuredContent: {
        id: row.id,
        docId: row.docId,
        parentCommentId: row.parentCommentId,
        content: row.content,
        anchor: row.anchor,
        createdAt: row.createdAt,
      },
    };
  };
}

// ---------------------------------------------------------------------------
// orboto_resolve_doc_comment
// ---------------------------------------------------------------------------

export const resolveDocCommentToolConfig = {
  title: 'Mark a doc comment thread as resolved (or reopen it)',
  description:
    'Toggle a comment thread\'s resolved state. Pass `resolved=true` to fold the conversation, `resolved=false` to reopen. Always acts on the thread ROOT — resolving from a reply folds the whole conversation, same as the web UI.',
  inputSchema: z.object({
    docId: z.string().uuid(),
    commentId: z.string().uuid(),
    resolved: z.boolean(),
  }).shape,
};

export function makeResolveDocCommentHandler(client: OrbotoClient) {
  return async ({ docId, commentId, resolved }: {
    docId: string; commentId: string; resolved: boolean;
  }): Promise<CallToolResult> => {
    const row = await client.post<DocCommentRow>(
      `/docs/${docId}/comments/${commentId}/resolve`,
      { resolved },
    );
    return {
      content: [{
        type: 'text',
        text: `Comment thread ${row.id} ${resolved ? 'resolved' : 'reopened'}.`,
      }],
      structuredContent: {
        id: row.id,
        resolvedAt: row.resolvedAt,
        resolvedBy: row.resolvedBy,
      },
    };
  };
}

// ---------------------------------------------------------------------------
// orboto_update_doc_comment — ORB-933
// ---------------------------------------------------------------------------

export const updateDocCommentToolConfig = {
  title: 'Edit your own doc comment',
  description:
    'Edit a doc comment\'s body. Author OR super-admin can edit; everyone else gets a 403. Doc-comments do not carry a revision history today (unlike ticket comments), so the prior content is overwritten in place. A no-op call (same content as before) returns the unchanged row.',
  inputSchema: z.object({
    docId: z.string().uuid(),
    commentId: z.string().uuid(),
    content: z.string().min(1).max(4000),
  }).shape,
};

export function makeUpdateDocCommentHandler(client: OrbotoClient) {
  return async ({ docId, commentId, content }: {
    docId: string; commentId: string; content: string;
  }): Promise<CallToolResult> => {
    const row = await client.patch<DocCommentRow>(`/docs/${docId}/comments/${commentId}`, { content });
    return {
      content: [{ type: 'text', text: `Doc comment ${row.id} updated.` }],
      structuredContent: {
        id: row.id,
        docId: row.docId,
        content: row.content,
      },
    };
  };
}

// ---------------------------------------------------------------------------
// orboto_delete_doc_comment
// ---------------------------------------------------------------------------

export const deleteDocCommentToolConfig = {
  title: 'Delete a doc comment',
  description:
    'DESTRUCTIVE — drops the comment + (via FK cascade) every reply under it. Only the author can delete their own comments; super-admins can delete anyone\'s. Returns success silently; 403 surfaces as an OrbotoApiError.',
  inputSchema: z.object({
    docId: z.string().uuid(),
    commentId: z.string().uuid(),
  }).shape,
  annotations: { destructiveHint: true },
};

export function makeDeleteDocCommentHandler(client: OrbotoClient) {
  return async ({ docId, commentId }: {
    docId: string; commentId: string;
  }): Promise<CallToolResult> => {
    await client.delete(`/docs/${docId}/comments/${commentId}`);
    return {
      content: [{ type: 'text', text: `Comment ${commentId} deleted from doc ${docId}.` }],
      structuredContent: { docId, commentId, deleted: true },
    };
  };
}
