/**
 * ORB-914 — doc-attachments MCP tools (epic ORB-911 Phase 3).
 *
 * Mirrors the ticket-attachment surface (apps/mcp/src/tools/attach.ts)
 * for doc pages. Three tools:
 *
 *   - orboto_upload_doc_attachment    — multipart upload + optional embed
 *   - orboto_list_doc_attachments     — flat list with download URLs
 *   - orboto_delete_doc_attachment    — destructive
 *
 * The embed branch on upload PATCHes the doc body to append a Markdown
 * image-or-link line, same pattern as orboto_attach_to_ticket. Useful
 * when an agent wants to drop a screenshot into a page in one call.
 *
 * MIME / extension policy is enforced server-side via `isAttachmentAllowed`
 * — the tool just surfaces the 415 as an OrbotoApiError so the caller
 * can pick a different file.
 */
import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { OrbotoClient } from '../orboto-client.js';
import { resolveDocId } from './docs.js';

interface AttachmentResponse {
  id: string;
  targetType: 'ticket' | 'doc' | 'comment';
  targetId: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
  uploadedBy: string | null;
  uploadedAt: string;
  downloadUrl?: string;
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

/**
 * Very small MIME guesser — same shape as attach.ts. The API also sniffs
 * the filename, so this only needs to land in the right ballpark for the
 * Blob's Content-Type header.
 */
function mimetypeFor(filename: string): string {
  const lower = filename.toLowerCase();
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  if (lower.endsWith('.gif')) return 'image/gif';
  if (lower.endsWith('.webp')) return 'image/webp';
  if (lower.endsWith('.pdf')) return 'application/pdf';
  if (lower.endsWith('.txt') || lower.endsWith('.log')) return 'text/plain';
  if (lower.endsWith('.md') || lower.endsWith('.markdown')) return 'text/markdown';
  if (lower.endsWith('.json')) return 'application/json';
  if (lower.endsWith('.csv')) return 'text/csv';
  if (lower.endsWith('.docx')) return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  return 'application/octet-stream';
}

function isImage(mimetype: string): boolean {
  return mimetype.startsWith('image/');
}

// ---------------------------------------------------------------------------
// orboto_upload_doc_attachment
// ---------------------------------------------------------------------------

export const uploadDocAttachmentToolConfig = {
  title: 'Upload an attachment to a doc page',
  description:
    'Upload a file as an attachment on a wiki doc and return its Markdown image (or link) line + the stable download URL. Bytes come in as base64 (`contentBase64`) so this works without local FS access on the agent side. Set `embed=true` to also PATCH the doc body to append the Markdown line — useful for dropping a screenshot into a page in one call. MIME / extension policy is enforced server-side: blocked types (HTML, SVG, executables) surface a 415.',
  inputSchema: z.object({
    docId: z.string().min(1).describe('Doc UUID or human-readable doc key (ORB-D12 / DOC-5).'),
    filename: z.string().min(1).describe('Display filename, e.g. "architecture-diagram.png".'),
    contentBase64: z.string().min(1).describe('File content, base64-encoded.'),
    altText: z.string().optional().describe('Alt-text for the Markdown image line. Defaults to filename.'),
    embed: z.boolean().optional().describe('If true, PATCHes the doc body to append the Markdown line. Idempotent up to duplicate detection — re-running appends another copy.'),
  }).shape,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
};

export function makeUploadDocAttachmentHandler(client: OrbotoClient) {
  return async ({ docId, filename, contentBase64, altText, embed }: {
    docId: string; filename: string; contentBase64: string;
    altText?: string; embed?: boolean;
  }): Promise<CallToolResult> => {
    docId = await resolveDocId(client, docId);
    let arrayBuffer: ArrayBuffer;
    try {
      // Buffer → fresh ArrayBuffer copy (see attach.ts for the Blob
      // type-constraint rationale).
      const buf = Buffer.from(contentBase64, 'base64');
      arrayBuffer = new ArrayBuffer(buf.byteLength);
      new Uint8Array(arrayBuffer).set(buf);
    } catch {
      throw new Error('contentBase64 is not valid base64.');
    }
    if (arrayBuffer.byteLength === 0) {
      throw new Error('contentBase64 decoded to 0 bytes — refuse to upload an empty file.');
    }

    const form = new FormData();
    form.append('file', new Blob([arrayBuffer], { type: mimetypeFor(filename) }), filename);
    const att = await client.postMultipart<AttachmentResponse>(`/docs/${docId}/attachments`, form);

    const alt = altText ?? att.filename;
    const url = att.downloadUrl ?? `/attachments/${att.id}`;
    const markdown = isImage(att.contentType)
      ? `![${alt}](${url})`
      : `[${alt}](${url})`;

    let embedded = false;
    if (embed === true) {
      // Read the current body first — PATCH /docs/:id replaces, not
      // appends. Then write the new body in one go.
      const current = await client.get<DocRow>(`/docs/${docId}`);
      const existing = current.content ?? '';
      const next = existing ? `${existing}\n\n${markdown}` : markdown;
      await client.patch(`/docs/${docId}`, { content: next });
      embedded = true;
    }

    return {
      content: [{
        type: 'text',
        text: `Attached ${att.filename} (${Math.round(att.sizeBytes / 1024)} KB) to doc ${docId}${embedded ? ' and embedded in body' : ''}.\n${markdown}`,
      }],
      structuredContent: {
        docId,
        attachmentId: att.id,
        filename: att.filename,
        sizeBytes: att.sizeBytes,
        contentType: att.contentType,
        downloadUrl: url,
        markdown,
        embedded,
      },
    };
  };
}

// ---------------------------------------------------------------------------
// orboto_list_doc_attachments
// ---------------------------------------------------------------------------

export const listDocAttachmentsToolConfig = {
  title: 'List attachments on a doc page',
  description:
    'Return the doc\'s attachments newest-first, with stable download URLs the agent can hand to the user. Empty list = no attachments.',
  inputSchema: z.object({
    docId: z.string().min(1).describe('Doc UUID or human-readable doc key (ORB-D12 / DOC-5).'),
  }).shape,
  annotations: { readOnlyHint: true, idempotentHint: true },
};

export function makeListDocAttachmentsHandler(client: OrbotoClient) {
  return async ({ docId }: { docId: string }): Promise<CallToolResult> => {
    docId = await resolveDocId(client, docId);
    const rows = await client.get<AttachmentResponse[]>(`/docs/${docId}/attachments`);
    if (rows.length === 0) {
      return {
        content: [{ type: 'text', text: 'No attachments on this doc.' }],
        structuredContent: { attachments: [] },
      };
    }
    const lines = rows.map((r) => {
      const url = r.downloadUrl ?? `/attachments/${r.id}`;
      const kb = Math.round(r.sizeBytes / 1024);
      return `- ${r.filename}  (${kb} KB, ${r.contentType}) → ${url}`;
    });
    return {
      content: [{ type: 'text', text: lines.join('\n') }],
      structuredContent: {
        attachments: rows.map((r) => ({
          id: r.id,
          filename: r.filename,
          contentType: r.contentType,
          sizeBytes: r.sizeBytes,
          uploadedAt: r.uploadedAt,
          uploadedBy: r.uploadedBy,
          downloadUrl: r.downloadUrl ?? `/attachments/${r.id}`,
        })),
      },
    };
  };
}

// ---------------------------------------------------------------------------
// orboto_delete_doc_attachment
// ---------------------------------------------------------------------------

export const deleteDocAttachmentToolConfig = {
  title: 'Delete an attachment from a doc page',
  description:
    'DESTRUCTIVE — drops the file row + deletes the underlying S3 object. Does NOT rewrite the doc body, so embedded Markdown lines pointing at the deleted URL will surface as broken images / links. Walk those by hand if needed.',
  inputSchema: z.object({
    docId: z.string().min(1).describe('Doc UUID or human-readable doc key (ORB-D12 / DOC-5).'),
    attachmentId: z.string().uuid(),
  }).shape,
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
};

export function makeDeleteDocAttachmentHandler(client: OrbotoClient) {
  return async ({ docId, attachmentId }: {
    docId: string; attachmentId: string;
  }): Promise<CallToolResult> => {
    docId = await resolveDocId(client, docId);
    await client.delete(`/docs/${docId}/attachments/${attachmentId}`);
    return {
      content: [{ type: 'text', text: `Attachment ${attachmentId} removed from doc ${docId}.` }],
      structuredContent: { docId, attachmentId, deleted: true },
    };
  };
}
