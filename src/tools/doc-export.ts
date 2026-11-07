/**
 * ORB-915 - doc-export MCP tools (epic ORB-911 Phase 4).
 */
import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { OrbotoClient } from '../orboto-client.js';
import { resolveDocId } from './docs.js';
import { DOC_ID_PARAM } from './shared.js';

export const exportDocMdToolConfig = {
  title: 'Export a doc as Markdown',
  description:
    'Return the doc body as Markdown. Differs from orboto_get_doc.content in that the server-side export endpoint emits the canonical saved body - agents pulling docs to feed into another tool should prefer this over get_doc, which wraps the body in get-doc envelope text + backlinks.',
  inputSchema: z.object({
    docId: z.string().min(1).describe(DOC_ID_PARAM),
  }).shape,
  annotations: { readOnlyHint: true, idempotentHint: true },
};

export function makeExportDocMdHandler(client: OrbotoClient) {
  return async ({ docId }: { docId: string }): Promise<CallToolResult> => {
    docId = await resolveDocId(client, docId);
    const markdown = await client.getText(`/docs/${docId}/export/md`);
    return {
      content: [{ type: 'text', text: markdown }],
      structuredContent: {
        docId,
        markdown,
        sizeBytes: Buffer.byteLength(markdown, 'utf8'),
      },
    };
  };
}

export const exportDocPdfToolConfig = {
  title: 'Export a doc as PDF',
  description:
    'Render a doc to PDF as a base64 resource attachment. Requires the PDF engine to be configured - deployments without Chromium / Puppeteer return 503 (errors.pdf.engine_unavailable) which surfaces as an OrbotoApiError.',
  inputSchema: z.object({
    docId: z.string().min(1).describe(DOC_ID_PARAM),
  }).shape,
  annotations: { readOnlyHint: true, idempotentHint: true },
};

export function makeExportDocPdfHandler(client: OrbotoClient) {
  return async ({ docId }: { docId: string }): Promise<CallToolResult> => {
    docId = await resolveDocId(client, docId);
    const { bytes, contentType } = await client.postBinary(`/docs/${docId}/export/pdf`);
    const base64 = Buffer.from(bytes).toString('base64');
    return {
      content: [
        {
          type: 'resource',
          resource: {
            uri: `orboto://doc/${docId}/export.pdf`,
            mimeType: contentType,
            blob: base64,
          },
        },
        {
          type: 'text',
          text: `Rendered ${docId} to PDF (${Math.round(bytes.byteLength / 1024)} KB).`,
        },
      ],
      structuredContent: {
        docId,
        sizeBytes: bytes.byteLength,
        contentType,
      },
    };
  };
}
