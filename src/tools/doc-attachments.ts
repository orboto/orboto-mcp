/**
 * ORB-914 - doc-attachments MCP tools (epic ORB-911 Phase 3).
 */
import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { OrbotoClient } from '../orboto-client.js';
import { readLocalAttachment } from '../local-file.js';
import { resolveDocId } from './docs.js';
import { DOC_ID_PARAM } from './shared.js';
import { attachmentBytes } from './attachment-input.js';

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
 * Very small MIME guesser - same shape as attach.ts. The API also sniffs
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

const UPLOAD_DOC_TAIL =
  'Returns its Markdown line and a stable download URL. `embed=true` also appends the line to the doc body (a re-run appends another copy). Blocked types (HTML, SVG, executables) answer 415.';

export const uploadDocAttachmentToolConfig = {
  title: 'Upload a doc attachment',
  description:
    `Upload a doc attachment from \`contentBase64\` (up to about 25 KB; a bigger file needs orboto_upload_link). ${UPLOAD_DOC_TAIL} The local stdio server also takes \`filePath\`.`,
  inputSchema: z.object({
    docId: z.string().min(1).describe(DOC_ID_PARAM),
    filename: z.string().min(1).describe('Display filename, e.g. "diagram.png".'),
    contentBase64: z.string().min(1),
    altText: z.string().optional().describe('Image alt text; default filename.'),
    embed: z.boolean().optional().describe('Append the Markdown line to the doc body.'),
  }).shape,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
};

/** The stdio variant: the server reads `filePath` itself, so the model carries no bytes. */
export const uploadDocAttachmentLocalToolConfig = {
  ...uploadDocAttachmentToolConfig,
  description:
    `Upload a doc attachment by \`filePath\` (this local server reads it, up to 50 MB) or \`contentBase64\` (up to about 25 KB). ${UPLOAD_DOC_TAIL} Without file access, orboto_upload_link mints a browser link for the person.`,
  inputSchema: z.object({
    docId: z.string().min(1).describe(DOC_ID_PARAM),
    filePath: z.string().min(1).optional(),
    filename: z.string().min(1).optional(),
    contentBase64: z.string().min(1).optional(),
    altText: z.string().optional().describe('Image alt text; default filename.'),
    embed: z.boolean().optional().describe('Append the Markdown line to the doc body.'),
  }).shape,
};

export function makeUploadDocAttachmentHandler(client: OrbotoClient, opts: { localFiles?: boolean } = {}) {
  return async ({ docId, filename, contentBase64, filePath, altText, embed }: {
    docId: string; filename?: string; contentBase64?: string; filePath?: string;
    altText?: string; embed?: boolean;
  }): Promise<CallToolResult> => {
    const file = await attachmentBytes({ filename, contentBase64, filePath, localFiles: opts.localFiles === true }, readLocalAttachment);
    docId = await resolveDocId(client, docId);

    const form = new FormData();
    form.append('file', new Blob([file.bytes], { type: mimetypeFor(file.filename) }), file.filename);
    const att = await client.postMultipart<AttachmentResponse>(`/docs/${docId}/attachments`, form);

    const alt = altText ?? att.filename;
    const url = att.downloadUrl ?? `/attachments/${att.id}`;
    const markdown = isImage(att.contentType)
      ? `![${alt}](${url})`
      : `[${alt}](${url})`;

    let embedded = false;
    if (embed === true) {
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

export const listDocAttachmentsToolConfig = {
  title: 'List doc attachments',
  description:
    'List a doc\'s attachments newest-first with stable download URLs. Empty list = no attachments.',
  inputSchema: z.object({
    docId: z.string().min(1).describe(DOC_ID_PARAM),
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

export const deleteDocAttachmentToolConfig = {
  title: 'Delete a doc attachment',
  description:
    'DESTRUCTIVE - drops the file row + deletes the underlying S3 object. Does NOT rewrite the doc body, so embedded Markdown lines pointing at the deleted URL will surface as broken images / links. Walk those by hand if needed.',
  inputSchema: z.object({
    docId: z.string().min(1).describe(DOC_ID_PARAM),
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
