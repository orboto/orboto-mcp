/**
 * ORB-2767 - a knowledge write answers with receipts; the MCP client takes them out of every JSON body, so no tool
 * repeats the receipt objects, and the tool result gets the receipt lines (about 25 tokens each) once, at its end.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

const scope = new AsyncLocalStorage<string[]>();

/** Removes a top-level `receipts` array from a response body and keeps its lines for the running tool call. */
export function takeReceipts<T>(body: T): T {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return body;
  const { receipts, ...rest } = body as Record<string, unknown>;
  if (!Array.isArray(receipts)) return body;
  const lines = scope.getStore();
  for (const r of receipts) {
    const line = (r as { line?: unknown } | null)?.line;
    if (lines && typeof line === 'string' && !lines.includes(line)) lines.push(line);
  }
  return rest as T;
}

/** Runs one tool call with its own receipt collector. */
export async function collectingReceipts<T>(run: () => Promise<T>): Promise<{ value: T; lines: string[] }> {
  const lines: string[] = [];
  const value = await scope.run(lines, run);
  return { value, lines };
}

/** The tool result with the receipt lines as its last text block. */
export function withReceiptLines(result: CallToolResult, lines: string[]): CallToolResult {
  if (lines.length === 0 || result.isError) return result;
  return { ...result, content: [...result.content, { type: 'text', text: lines.join('\n') }] };
}
