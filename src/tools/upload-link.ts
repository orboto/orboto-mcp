/** ORB-2758 - mint a single-use browser upload link, so a file the model cannot carry as base64 still lands on a ticket or doc. */
import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { OrbotoClient } from '../orboto-client.js';
import { resolveTicketByKey, DOC_ID_PARAM } from './shared.js';
import { resolveDocId } from './docs.js';

interface UploadLinkResponse {
  id: string;
  url: string;
  expiresAt: string;
  targetType: 'ticket' | 'doc';
  targetId: string;
  targetKey: string | null;
  maxBytes: number;
}

export const uploadLinkToolConfig = {
  title: 'Mint a browser upload link',
  description:
    'Mint a single-use link for a ticket or doc and give its URL to the person, who drops the file there (up to 50 MB, no login). For any file too big for `contentBase64` (about 25 KB). Pass `ticketKey` or `docId`. The link expires after `expiresInMinutes` (default 15, max 60), keeps the type policy and the storage quota, and is audited with your identity. A built-in agent browser cannot upload files, so do not open the link yourself. Mirrors `orboto attach link`.',
  inputSchema: z.object({
    ticketKey: z.string().min(3).optional(),
    docId: z.string().min(1).optional().describe(DOC_ID_PARAM),
    expiresInMinutes: z.number().int().min(1).max(60).optional(),
  }).shape,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
};

export function makeUploadLinkHandler(client: OrbotoClient) {
  return async ({ ticketKey, docId, expiresInMinutes }: { ticketKey?: string; docId?: string; expiresInMinutes?: number }): Promise<CallToolResult> => {
    if ((ticketKey === undefined) === (docId === undefined)) throw new Error('Pass exactly one of ticketKey or docId.');
    const body = expiresInMinutes === undefined ? {} : { expiresInMinutes };
    const link = ticketKey !== undefined
      ? await client.post<UploadLinkResponse>(`/tickets/${(await resolveTicketByKey(client, ticketKey)).id}/attachments/upload-links`, body)
      : await client.post<UploadLinkResponse>(`/docs/${await resolveDocId(client, docId!)}/attachments/upload-links`, body);
    const target = link.targetKey ?? `${link.targetType} ${link.targetId}`;
    return {
      content: [{
        type: 'text',
        text: `Upload link for ${target}, single use, expires ${link.expiresAt}:\n${link.url}\nGive this URL to the person: they open it in their own browser and drop the file (max ${Math.round(link.maxBytes / (1024 * 1024))} MB). Do not open it in your own browser; it cannot upload files.`,
      }],
      structuredContent: {
        url: link.url,
        expiresAt: link.expiresAt,
        targetType: link.targetType,
        targetKey: link.targetKey,
        maxBytes: link.maxBytes,
        handTo: 'person',
      },
    };
  };
}
