/**
 * ORB-799 - attach files to a ticket.
 */
import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { OrbotoClient } from '../orboto-client.js';
import { resolveTicketByKey, type TicketRow } from './shared.js';

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

export const attachToTicketToolConfig = {
  title: 'Attach a file to a ticket',
  description:
    'Upload a file as an attachment on a ticket and return its markdown image-embed line + raw URL. The bytes come in as base64 (`contentBase64`) so this works without local FS access on the agent side. Set `embed=true` to also PATCH the ticket\'s description with the markdown line appended (idempotent only up to duplicate detection - re-running with the same file appends another copy). Use `altText` for accessibility / image alt-text; defaults to the filename. Mirrors `orboto.mjs attach`.',
  inputSchema: z.object({
    ticketKey: z.string().min(3),
    filename: z.string().min(1).describe('Display filename, e.g. "graph-q3.png".'),
    contentBase64: z.string().min(1).describe('File content, base64-encoded.'),
    altText: z.string().optional().describe('Alt-text for the markdown image line. Defaults to filename.'),
    embed: z.boolean().optional().describe('If true, also PATCH the ticket\'s description to append the markdown image line.'),
  }).shape,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
};

export function makeAttachToTicketHandler(client: OrbotoClient) {
  return async ({ ticketKey, filename, contentBase64, altText, embed }: {
    ticketKey: string;
    filename: string;
    contentBase64: string;
    altText?: string;
    embed?: boolean;
  }): Promise<CallToolResult> => {
    let arrayBuffer: ArrayBuffer;
    try {
      const buf = Buffer.from(contentBase64, 'base64');
      arrayBuffer = new ArrayBuffer(buf.byteLength);
      new Uint8Array(arrayBuffer).set(buf);
    } catch {
      throw new Error('contentBase64 is not valid base64.');
    }
    if (arrayBuffer.byteLength === 0) {
      throw new Error('contentBase64 decoded to 0 bytes - refuse to upload an empty file.');
    }

    const ticket = await resolveTicketByKey(client, ticketKey);

    const form = new FormData();
    form.append(
      'file',
      new Blob([arrayBuffer], { type: mimetypeFor(filename) }),
      filename,
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
