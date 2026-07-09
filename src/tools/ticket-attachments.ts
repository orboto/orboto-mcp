/**
 * ORB-1455 - read + view ticket attachments from MCP.
 *
 * Every agent surface could WRITE attachments (orboto_attach_to_ticket) but
 * none could READ them: an agent working a ticket could not tell the ticket
 * HAD files, let alone SEE an attached screenshot. These two tools close that
 * hole (orboto_get_ticket also gains an `attachments` array):
 *
 *   - orboto_list_ticket_attachments - thin wrapper on the ticket-attachment
 *     list route; mirrors orboto_list_doc_attachments (ORB-914).
 *   - orboto_get_attachment - fetch an attachment's bytes via the new
 *     authenticated base64 route and return them to the model:
 *       * images (image/*)      -> an MCP image content block so the model
 *                                  actually VIEWS the screenshot, plus a text
 *                                  line with filename/size.
 *       * everything else       -> a text block with metadata + the base64
 *                                  (small files) or a pointer to the skill
 *                                  download shortcut (large files).
 *     Works for ticket/doc/comment attachments - the id is global.
 */
import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { OrbotoClient } from '../orboto-client.js';
import { resolveTicketByKey } from './shared.js';

interface AttachmentResponse {
  id: string;
  targetType?: 'ticket' | 'doc' | 'comment';
  targetId?: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
  uploadedBy?: string | null;
  uploadedAt?: string;
  downloadUrl?: string;
}

interface AttachmentBytesResponse {
  id: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
  contentBase64: string;
}

/** Max bytes we inline into a tool result. Screenshots are well under this;
 *  anything larger is pointed at the skill download shortcut so we don't
 *  bloat the model's context with a multi-MB base64 blob. */
const MAX_INLINE_BYTES = 5 * 1024 * 1024;

function isImage(mimetype: string): boolean {
  return mimetype.startsWith('image/');
}

// ---------------------------------------------------------------------------
// orboto_list_ticket_attachments
// ---------------------------------------------------------------------------

export const listTicketAttachmentsToolConfig = {
  title: 'List attachments on a ticket',
  description:
    'Return a ticket\'s attachments newest-first, with each attachment\'s id, filename, content type, size, and stable download URL. Use the returned id with orboto_get_attachment to actually view an image or fetch the bytes. Empty list = no attachments. Input is the ticket key like "ACME-42".',
  inputSchema: z.object({
    ticketKey: z.string().min(3).describe('Ticket key like "ACME-42".'),
  }).shape,
  annotations: { readOnlyHint: true, idempotentHint: true },
};

export function makeListTicketAttachmentsHandler(client: OrbotoClient) {
  return async ({ ticketKey }: { ticketKey: string }): Promise<CallToolResult> => {
    const ticket = await resolveTicketByKey(client, ticketKey);
    const rows = await client.get<AttachmentResponse[]>(`/tickets/${ticket.id}/attachments`);
    if (rows.length === 0) {
      return {
        content: [{ type: 'text', text: `No attachments on [${ticket.ticketKey}].` }],
        structuredContent: { ticketKey: ticket.ticketKey, attachments: [] },
      };
    }
    const lines = rows.map((r) => {
      const url = r.downloadUrl ?? `/attachments/${r.id}`;
      const kb = Math.round(r.sizeBytes / 1024);
      return `- ${r.filename}  (${kb} KB, ${r.contentType})  id=${r.id} → ${url}`;
    });
    return {
      content: [{
        type: 'text',
        text: `Attachments on [${ticket.ticketKey}]:\n${lines.join('\n')}\n\nUse orboto_get_attachment with an id to view an image or fetch bytes.`,
      }],
      structuredContent: {
        ticketKey: ticket.ticketKey,
        attachments: rows.map((r) => ({
          id: r.id,
          filename: r.filename,
          contentType: r.contentType,
          sizeBytes: r.sizeBytes,
          uploadedAt: r.uploadedAt ?? null,
          uploadedBy: r.uploadedBy ?? null,
          downloadUrl: r.downloadUrl ?? `/attachments/${r.id}`,
        })),
      },
    };
  };
}

// ---------------------------------------------------------------------------
// orboto_get_attachment
// ---------------------------------------------------------------------------

export const getAttachmentToolConfig = {
  title: 'View or fetch an attachment\'s bytes',
  description:
    'Fetch a single attachment by its id (from orboto_list_ticket_attachments, orboto_get_ticket, or orboto_list_doc_attachments) and return its content. For an image, the model receives an image content block so it actually SEES the screenshot, plus a text line with filename and size. For a non-image, the model gets a text block with metadata and, for small files, the base64 content; large binaries point at the skill\'s download-attachment shortcut. Works for ticket, doc, and comment attachments (the id is global). Enforces the same project/space access check as listing the attachment.',
  inputSchema: z.object({
    attachmentId: z.string().uuid().describe('Attachment UUID from a list/get call.'),
  }).shape,
  annotations: { readOnlyHint: true, idempotentHint: true },
};

export function makeGetAttachmentHandler(client: OrbotoClient) {
  return async ({ attachmentId }: { attachmentId: string }): Promise<CallToolResult> => {
    const att = await client.get<AttachmentBytesResponse>(`/attachments/${attachmentId}/base64`);
    const kb = Math.round(att.sizeBytes / 1024);

    // Over the inline cap: refuse to spill a multi-MB blob into the model's
    // context. Point at the skill download shortcut, which streams to disk.
    if (att.sizeBytes > MAX_INLINE_BYTES) {
      return {
        content: [{
          type: 'text',
          text: `${att.filename} (${kb} KB, ${att.contentType}) is larger than the ${Math.round(
            MAX_INLINE_BYTES / (1024 * 1024),
          )} MB inline limit. Download it with the skill shortcut: \`orboto.mjs download-attachment ${att.id}\`.`,
        }],
        structuredContent: {
          id: att.id, filename: att.filename, contentType: att.contentType, sizeBytes: att.sizeBytes, inlined: false,
        },
      };
    }

    if (isImage(att.contentType)) {
      return {
        content: [
          { type: 'text', text: `${att.filename} (${kb} KB, ${att.contentType})` },
          { type: 'image', data: att.contentBase64, mimeType: att.contentType },
        ],
        structuredContent: {
          id: att.id, filename: att.filename, contentType: att.contentType, sizeBytes: att.sizeBytes, inlined: true,
        },
      };
    }

    // Non-image: return metadata + the base64 so an agent can decode / save it.
    return {
      content: [{
        type: 'text',
        text: `${att.filename} (${kb} KB, ${att.contentType})\nbase64:\n${att.contentBase64}`,
      }],
      structuredContent: {
        id: att.id,
        filename: att.filename,
        contentType: att.contentType,
        sizeBytes: att.sizeBytes,
        inlined: true,
        contentBase64: att.contentBase64,
      },
    };
  };
}
