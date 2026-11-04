/**
 * ORB-799 - attach files to a ticket.
 */
import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { OrbotoClient } from '../orboto-client.js';
import { readLocalAttachment } from '../local-file.js';
import { resolveTicketByKey, type TicketRow } from './shared.js';
import { attachmentBytes } from './attachment-input.js';

interface AttachmentResponse {
  id: string;
  filename: string;
  mimetype: string;
  sizeBytes: number;
  downloadUrl: string;
}

function mimetypeFor(filename: string): string {
  const lower = filename.toLowerCase();
  if (lower.endsWith('.pdf')) return 'application/pdf';
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  if (lower.endsWith('.gif')) return 'image/gif';
  if (lower.endsWith('.webp')) return 'image/webp';
  if (lower.endsWith('.svg')) return 'image/svg+xml';
  if (lower.endsWith('.txt') || lower.endsWith('.log')) return 'text/plain';
  if (lower.endsWith('.json')) return 'application/json';
  return 'application/octet-stream';
}

const ATTACH_TAIL =
  'Returns its Markdown line and URL. `embed=true` also appends the line to the ticket description (a re-run appends another copy); `altText` defaults to the filename. Mirrors `orboto.mjs attach`.';

export const attachToTicketToolConfig = {
  title: 'Attach a file to a ticket',
  description:
    `Attach a file to a ticket from \`contentBase64\` (up to about 25 KB; a bigger file needs orboto_upload_link). ${ATTACH_TAIL} The local stdio server also takes \`filePath\`.`,
  inputSchema: z.object({
    ticketKey: z.string().min(3),
    filename: z.string().min(1).describe('Display filename, e.g. "graph-q3.png".'),
    contentBase64: z.string().min(1),
    altText: z.string().optional().describe('Image alt text; default filename.'),
    embed: z.boolean().optional().describe('Also append the image line to the description.'),
  }).shape,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
};

/** The stdio variant: the server reads `filePath` itself, so the model carries no bytes. */
export const attachToTicketLocalToolConfig = {
  ...attachToTicketToolConfig,
  description:
    `Attach a file to a ticket by \`filePath\` (this local server reads it, up to 50 MB) or \`contentBase64\` (up to about 25 KB). ${ATTACH_TAIL} Without file access, orboto_upload_link mints a browser link for the person.`,
  inputSchema: z.object({
    ticketKey: z.string().min(3),
    filePath: z.string().min(1).optional(),
    filename: z.string().min(1).optional(),
    contentBase64: z.string().min(1).optional(),
    altText: z.string().optional().describe('Image alt text; default filename.'),
    embed: z.boolean().optional().describe('Also append the image line to the description.'),
  }).shape,
};

export function makeAttachToTicketHandler(client: OrbotoClient, opts: { localFiles?: boolean } = {}) {
  return async ({ ticketKey, filename, contentBase64, filePath, altText, embed }: {
    ticketKey: string;
    filename?: string;
    contentBase64?: string;
    filePath?: string;
    altText?: string;
    embed?: boolean;
  }): Promise<CallToolResult> => {
    const file = await attachmentBytes({ filename, contentBase64, filePath, localFiles: opts.localFiles === true }, readLocalAttachment);
    const ticket = await resolveTicketByKey(client, ticketKey);

    const form = new FormData();
    form.append(
      'file',
      new Blob([file.bytes], { type: mimetypeFor(file.filename) }),
      file.filename,
    );
    const att = await client.postMultipart<AttachmentResponse>(
      `/tickets/${ticket.id}/attachments`,
      form,
    );
    const alt = altText ?? att.filename;
    const markdown = `![${alt}](${att.downloadUrl})`;

    let embedded = false;
    if (embed === true) {
      const current = await client.get<TicketRow>(
        `/projects/${ticket.projectId}/tickets/${ticket.id}`,
      );
      const existing = current.description ?? '';
      const next = existing ? `${existing}\n\n${markdown}` : markdown;
      await client.patch(
        `/projects/${ticket.projectId}/tickets/${ticket.id}`,
        { description: next },
      );
      embedded = true;
    }

    return {
      content: [{
        type: 'text',
        text: `Attached ${att.filename} (${Math.round(att.sizeBytes / 1024)} KB) to [${ticket.ticketKey}]${embedded ? ' and embedded in description' : ''}.\n${markdown}`,
      }],
      structuredContent: {
        ticketKey: ticket.ticketKey,
        attachmentId: att.id,
        filename: att.filename,
        sizeBytes: att.sizeBytes,
        mimetype: att.mimetype,
        url: att.downloadUrl,
        markdown,
        embedded,
      },
    };
  };
}
