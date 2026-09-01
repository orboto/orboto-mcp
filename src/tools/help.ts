/**
 * ORB-1741 - `orboto_help`: lazy full guidance for one tool.
 *
 * The manifest carries one-sentence summaries (the diet in
 * tool-docs.ts); the complete guidance text - workflows, warnings, edge
 * cases - is served HERE on demand, so a session only pays for the docs
 * of tools it actually reasons about. Same pattern as deferred-tool
 * schemas via ToolSearch.
 */
import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { getToolDoc, listToolDocNames } from '../tool-docs.js';

export const helpToolConfig = {
  title: 'Full guidance for one orboto tool',
  description:
    'Return the complete guidance text (workflows, warnings, edge cases) for one orboto tool by name - manifest descriptions are one-line summaries, this is the rest. Call it before first use of an unfamiliar write tool.',
  inputSchema: z.object({
    tool: z.string().min(1).max(128).describe('Tool name, e.g. orboto_create_ticket.'),
  }).shape,
  outputSchema: z.object({
    tool: z.string(),
    guidance: z.string(),
  }).shape,
  annotations: { readOnlyHint: true, idempotentHint: true },
};

export function makeHelpHandler() {
  return async (args: { tool: string }): Promise<CallToolResult> => {
    const name = args.tool.trim();
    const doc = getToolDoc(name) ?? getToolDoc(`orboto_${name}`);
    if (!doc) {
      const known = listToolDocNames();
      return {
        content: [{
          type: 'text',
          text: `No guidance registered for "${name}". Known tools (${known.length}): ${known.join(', ')}`,
        }],
        structuredContent: { tool: name, guidance: '' },
      };
    }
    const resolved = getToolDoc(name) ? name : `orboto_${name}`;
    return {
      content: [{ type: 'text', text: doc }],
      structuredContent: { tool: resolved, guidance: doc },
    };
  };
}
