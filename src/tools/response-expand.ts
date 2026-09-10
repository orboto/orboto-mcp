/**
 * ORB-1697 - `orboto_response_expand`: the way back from a truncated
 * response.
 */
import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import {
  budgetFor,
  readPayload,
  resolvePath,
  type OmittedEntry,
} from '../response-budget.js';

export const responseExpandToolConfig = {
  title: 'Fetch the omitted part of a truncated response',
  description:
    'Return the content a previous tool response omitted. When a result exceeds its response budget it comes back with a `__truncation` block containing a `handle` and the list of cut paths; pass that handle here to read the omitted remainder. Call with `handle` alone to list what is available, then with `path` (e.g. "description" or "ticketBundle.primer.markdown", or "$text" for the human-readable block) to read it, following `nextCursor` while it is not null. Handles live 15 minutes in the MCP server process - if one has expired, re-run the original tool. Read-only; returns nothing the original call did not already return.',
  inputSchema: z.object({
    handle: z.string().min(4).max(64).describe('From a response\'s `__truncation` block.'),
    path: z.string().max(400).optional().describe('One of `__truncation.omitted[].path`, or "$text". Omit to list them.'),
    cursor: z.number().int().min(0).optional().describe('`nextCursor` from the previous chunk.'),
  }).shape,
  annotations: { readOnlyHint: true, idempotentHint: true },
};

function expired(handle: string): CallToolResult {
  const text =
    `No stored payload for handle "${handle}". Handles live 15 minutes in the MCP server process and only the `
    + '16 most recent are kept, so this one has expired or the server restarted. Re-run the original tool to get a fresh handle.';
  return { isError: true, content: [{ type: 'text', text }] };
}

function describeOmitted(entries: OmittedEntry[]): string {
  if (entries.length === 0) return '(nothing recorded as omitted for this handle)';
  return entries
    .map((e) => e.kind === 'string'
      ? `- ${e.path} (string, ${e.omittedChars ?? 0} chars omitted)`
      : `- ${e.path} (array, ${e.omittedItems ?? 0} of ${(e.keptItems ?? 0) + (e.omittedItems ?? 0)} items omitted)`)
    .join('\n');
}

export function makeResponseExpandHandler() {
  return async (input: { handle: string; path?: string; cursor?: number }): Promise<CallToolResult> => {
    const stored = readPayload(input.handle);
    if (!stored) return expired(input.handle);

    const omitted = stored.omitted ?? [];

    if (!input.path) {
      const lines = [
        `# Truncated content available for handle "${input.handle}"`,
        `Original tool: ${stored.toolName}`,
        '',
        describeOmitted(omitted),
        '',
        'Call again with one of these `path` values to read it.',
      ];
      return {
        content: [{ type: 'text', text: lines.join('\n') }],
        structuredContent: {
          handle: input.handle,
          toolName: stored.toolName,
          omitted,
        },
      };
    }

    const raw = input.path === '$text'
      ? stored.text
      : resolvePath(stored.structuredContent, input.path);
    if (raw === undefined) {
      const text =
        `Path "${input.path}" does not exist in the stored payload for handle "${input.handle}". `
        + `Available paths:\n${describeOmitted(omitted)}`;
      return { isError: true, content: [{ type: 'text', text }] };
    }

    const full = typeof raw === 'string' ? raw : JSON.stringify(raw, null, 1) ?? '';
    const chunkSize = Math.max(500, budgetFor('orboto_response_expand') - 800);
    const cursor = Math.min(input.cursor ?? 0, full.length);
    const chunk = full.slice(cursor, cursor + chunkSize);
    const nextCursor = cursor + chunk.length < full.length ? cursor + chunk.length : null;

    const header = `# ${input.path} (chars ${cursor}-${cursor + chunk.length} of ${full.length})`;
    const footer = nextCursor === null
      ? '(end of value)'
      : `(more follows - call again with cursor=${nextCursor})`;

    return {
      content: [{ type: 'text', text: `${header}\n\n${chunk}\n\n${footer}` }],
      structuredContent: {
        handle: input.handle,
        path: input.path,
        chunk,
        cursor,
        nextCursor,
        totalChars: full.length,
        isString: typeof raw === 'string',
      },
    };
  };
}
