/**
 * ORB-311 Phase F — wrap a tool handler so every dispatch logs to
 * `/admin/mcp/instrument` after the call completes.
 *
 * Fire-and-forget: the POST runs after the handler resolves but
 * before the result reaches the MCP client only when its preceding
 * await is already done. We use `void postLogEntry(...)` so the
 * Promise floats; failures inside the logger never bubble back to
 * the user. A failed log = no row, never a failed tool call.
 *
 * Latency cost: one HTTP round-trip per tool dispatch. For
 * stdio (loopback) and self-hosted-inline (container-to-container)
 * that's negligible. For Cloud-Managed it adds ~10-30 ms; if that
 * matters in the future, batch the logger by buffering N entries
 * and flushing on a timer.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { OrbotoApiError, type OrbotoClient } from './orboto-client.js';
import { type NudgeState, shouldNudge, prependNudge } from './session-nudge.js';

/**
 * ORB-1174 — turn an OrbotoApiError into an actionable, agent-visible
 * tool-error message. Before this, a thrown error reached the MCP runtime
 * as a generic "Error occurred during tool execution" — an MCP-only agent
 * couldn't tell 401 (auth) from 404 (not found) from 500 (server) and so
 * couldn't self-correct. We surface the status + a one-line hint + the
 * API's own message. The API error body is workspace error text (no
 * secrets); we still cap its length defensively.
 */
function formatApiError(err: OrbotoApiError): string {
  let detail = err.body || '';
  try {
    const parsed = JSON.parse(err.body) as { error?: string; errorKey?: string };
    if (parsed.error) detail = parsed.error;
  } catch { /* body wasn't JSON — use it raw */ }
  detail = detail.slice(0, 400);

  const hint =
    err.status === 401 ? 'Authentication failed — your token is invalid or expired. Re-authenticate (re-run the OAuth connect, or check the API key).'
    : err.status === 403 ? 'Permission denied — your account lacks the required permission for this action.'
    : err.status === 404 ? 'Not found — the referenced ticket / project / resource does not exist or you cannot see it.'
    : err.status === 409 ? 'Conflict — the resource already exists or is in a state that blocks this change.'
    : err.status === 422 ? 'Validation failed — the request was understood but rejected; adjust the input.'
    : err.status === 429 ? 'Rate limited — slow down and retry shortly.'
    : err.status >= 500 ? 'orboto server error — transient; retry shortly. If it persists the API may be mid-deploy.'
    : 'Request rejected.';

  return `orboto API error ${err.status}. ${hint}\nDetail: ${detail || '(no message)'}`;
}

interface LogEntry {
  toolName: string;
  durationMs: number;
  success: boolean;
  errorMessage?: string;
  /** ORB-1180 — HTTP status of the failing API call (OrbotoApiError). */
  statusCode?: number;
  clientHint?: string;
}

/**
 * ORB-1180 — defensive secret-redaction on anything we persist to the
 * admin MCP panel. The API error body is workspace error text (no
 * secrets), but the non-API error path is `err.message` from arbitrary
 * code and could carry a token / Authorization header / creds-in-URL.
 * Strip the obvious shapes before the log row is written.
 */
function redactSecrets(text: string): string {
  return text
    .replace(/orb_[A-Za-z0-9_-]{8,}/g, 'orb_[redacted]')
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
    .replace(/eyJ[A-Za-z0-9._-]{10,}/g, '[redacted-jwt]')
    .replace(/(https?:\/\/)[^/\s:@]+:[^/\s@]+@/gi, '$1[redacted]@');
}

async function postLogEntry(client: OrbotoClient, entry: LogEntry): Promise<void> {
  try {
    await client.post('/admin/mcp/instrument', entry);
  } catch {
    // Swallow — instrumentation must never fail the tool call. If the
    // workspace is mid-restart or rate-limited, we'd rather lose a
    // few rows than break user-visible behaviour.
  }
}

/**
 * Wrap a CallToolResult-returning handler so every invocation posts
 * one row to mcp_call_log via /admin/mcp/instrument.
 *
 * Used as: `withMetrics(client, 'orboto_get_ticket', clientHint, makeGetTicketHandler(client))`
 *
 * Wired centrally in `server.ts` so per-tool files don't need to
 * know about instrumentation.
 */
export function withMetrics<TArgs extends Record<string, unknown> | undefined>(
  client: OrbotoClient,
  toolName: string,
  clientHint: string | undefined,
  // ORB-1252 — forward the SDK's `extra` (RequestHandlerExtra) so handlers can
  // read the per-connection MCP sessionId (distinct per HTTP client even on a
  // shared server). Backward-compatible: handlers that ignore it are unaffected.
  handler: (args: TArgs, extra?: unknown) => Promise<CallToolResult>,
  // ORB-1331 — per-session/-process nudge state. When present, the first
  // tool dispatch that is not `orboto_session_start` gets the one-time
  // reminder prepended to its response. Optional so direct callers/tests
  // that don't care are unaffected.
  nudge?: NudgeState,
): (args: TArgs, extra?: unknown) => Promise<CallToolResult> {
  return async (args: TArgs, extra?: unknown): Promise<CallToolResult> => {
    const start = Date.now();
    // ORB-1331 — decide (and advance the flag) once per dispatch, before
    // the handler runs, so the "first tool call" is the first dispatch
    // regardless of its outcome. Applied to the returned result below.
    const wantsNudge = nudge ? shouldNudge(nudge, toolName) : false;
    try {
      const result = await handler(args, extra);
      // Success path — but the handler can also signal a "soft"
      // failure via { isError: true } in the result. We treat that
      // as success=false in the log so dashboards reflect actual
      // user-visible failures.
      const isError = result.isError === true;
      void postLogEntry(client, {
        toolName,
        durationMs: Date.now() - start,
        success: !isError,
        errorMessage: isError && result.content[0] && 'text' in result.content[0]
          ? redactSecrets(String(result.content[0].text)).slice(0, 500)
          : undefined,
        clientHint,
      });
      return wantsNudge ? prependNudge(result) : result;
    } catch (err) {
      const durationMs = Date.now() - start;
      // ORB-1174 — an OrbotoApiError carries a real HTTP status + message.
      // Return it as a structured isError result so the agent + human see
      // WHY (401 vs 404 vs 500) and can self-correct, instead of the
      // runtime's opaque "Error occurred during tool execution".
      if (err instanceof OrbotoApiError) {
        const text = formatApiError(err);
        void postLogEntry(client, { toolName, durationMs, success: false, statusCode: err.status, errorMessage: redactSecrets(text).slice(0, 500), clientHint });
        // Still surface the reminder alongside the actionable error so a
        // first-call failure doesn't swallow the one-time nudge.
        const errResult: CallToolResult = { isError: true, content: [{ type: 'text', text }] };
        return wantsNudge ? prependNudge(errResult) : errResult;
      }
      // Anything else is unexpected (a bug, not an API rejection) — log
      // and re-throw so it surfaces loudly rather than being swallowed.
      void postLogEntry(client, {
        toolName,
        durationMs,
        success: false,
        errorMessage: redactSecrets(err instanceof Error ? err.message : String(err)).slice(0, 500),
        clientHint,
      });
      throw err;
    }
  };
}

/**
 * Helper for `server.ts` — wraps `server.registerTool` so call sites
 * stay one-liners without leaking the metrics layer everywhere.
 *
 * Usage:
 *   const reg = registerWithMetrics(server, client, clientHint);
 *   reg('orboto_list_projects', listProjectsToolConfig, makeListProjectsHandler(client));
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ToolConfig = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ToolHandler = (args: any, extra?: any) => Promise<CallToolResult>;

/**
 * Both `config` and the registerTool call use loose types — the SDK
 * has multiple overloads (with / without input schema) and threading
 * generic params through the wrapper makes TS pick the wrong overload
 * for some tools (the admin ones in this case land on the
 * no-input-schema overload). Type-correctness is enforced at the
 * original tool-config declaration site instead.
 */
export function registerWithMetrics(
  server: McpServer,
  client: OrbotoClient,
  clientHint: string | undefined,
  // ORB-1331 — shared per-session/-process nudge state. Every tool
  // registered through this closure reads/advances the same flag, so the
  // one-time session-start reminder fires on whichever tool is called
  // first (unless it is `orboto_session_start`).
  nudge?: NudgeState,
) {
  return (toolName: string, config: ToolConfig, handler: ToolHandler): void => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (server.registerTool as any)(
      toolName,
      config,
      withMetrics(client, toolName, clientHint, handler, nudge),
    );
  };
}
