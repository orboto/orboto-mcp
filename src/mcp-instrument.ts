/**
 * ORB-1817 - shared instrument-log primitives, split out of with-metrics.ts
 * so `input-schema.ts` can log validation failures too without creating an
 * import cycle (with-metrics.ts already imports FROM input-schema.ts to
 * build the strict + alias-resolving schema). Keep this a LEAF module:
 * it must never import from with-metrics.ts or input-schema.ts.
 */
import type { OrbotoClient } from './orboto-client.js';

export interface McpLogEntry {
  toolName: string;
  durationMs: number;
  success: boolean;
  errorMessage?: string;
  /** ORB-1180 - HTTP status of the failing API call (OrbotoApiError).
   *  ORB-1817 - also carries the JSON-RPC code -32602 for an input
   *  validation failure, so it never falls outside the HTTP range. */
  statusCode?: number;
  clientHint?: string;
  /** ORB-1697 - characters the client actually pays for, AFTER the
   *  response budget was applied. */
  responseChars?: number;
  /** ORB-1697 - characters the budget removed (0 when nothing was cut).
   *  Makes budget pressure per tool visible in the admin MCP-usage panel
   *  instead of needing another one-off transcript audit. */
  truncatedChars?: number;
}

/**
 * ORB-1180 - defensive secret-redaction on anything we persist to the
 * admin MCP panel. The API error body is workspace error text (no
 * secrets), but the non-API error path is `err.message` from arbitrary
 * code and could carry a token / Authorization header / creds-in-URL.
 * Strip the obvious shapes before the log row is written.
 */
export function redactSecrets(text: string): string {
  return text
    .replace(/orb_[A-Za-z0-9_-]{8,}/g, 'orb_[redacted]')
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
    .replace(/eyJ[A-Za-z0-9._-]{10,}/g, '[redacted-jwt]')
    .replace(/(https?:\/\/)[^/\s:@]+:[^/\s@]+@/gi, '$1[redacted]@');
}

export async function postLogEntry(client: OrbotoClient, entry: McpLogEntry): Promise<void> {
  try {
    await client.post('/admin/mcp/instrument', entry);
  } catch {
    // Swallow - instrumentation must never fail the tool call. If the
    // workspace is mid-restart or rate-limited, we'd rather lose a
    // few rows than break user-visible behaviour.
  }
}
