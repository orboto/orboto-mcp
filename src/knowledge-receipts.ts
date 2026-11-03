/**
 * ORB-2767 - a knowledge write answers with receipts; the MCP client takes them out of every JSON body, so no tool
 * repeats the receipt objects, and the tool result gets the receipt lines (about 25 tokens each) once, at its end.
 * ORB-2792 - the `privateRemoved` count leaves the body too: a receipt line names it, and its own line is added only
 * when no receipt line does or when it carries the warning of an unclosed or an unopened marker.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

const scope = new AsyncLocalStorage<string[]>();

/** Removes a top-level `receipts` array and `privateRemoved` object from a response body and keeps their lines for the running tool call. */
export function takeReceipts<T>(body: T): T {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return body;
  const { receipts, privateRemoved, ...rest } = body as Record<string, unknown>;
  const hasReceipts = Array.isArray(receipts);
  const removed = privateRemoved && typeof privateRemoved === 'object' ? privateRemoved as { line?: unknown; unclosed?: unknown; unopened?: unknown } : null;
  if (!hasReceipts && !removed) return body;
  const lines = scope.getStore();
  const keep = (line: unknown) => { if (lines && typeof line === 'string' && !lines.includes(line)) lines.push(line); };
  for (const r of hasReceipts ? receipts : []) keep((r as { line?: unknown } | null)?.line);
  if (removed && (removed.unclosed === true || removed.unopened === true || !hasReceipts || receipts.length === 0)) keep(removed.line);
  return (hasReceipts || removed ? rest : body) as T;
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
