/**
 * ORB-311 Phase F - wrap a tool handler so every dispatch logs to
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
import { type NudgeState, shouldNudge, prependNudge, shouldGate, gateResult, recordSessionStartResult } from './session-nudge.js';
import { RequiredRulesError } from './required-rules.js';
import { applyResponseBudget, TruncationBlockAdvertisedSchema } from './response-budget.js';
import { buildStrictInputSchema, isRawShape } from './input-schema.js';
import { captureToolDoc, summarizeToolDescription } from './tool-docs.js';
import { postLogEntry, redactSecrets } from './mcp-instrument.js';

/**
 * ORB-1174 - turn an OrbotoApiError into an actionable, agent-visible
 * tool-error message. Before this, a thrown error reached the MCP runtime
 * as a generic "Error occurred during tool execution" - an MCP-only agent
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
  } catch { /* body wasn't JSON - use it raw */ }
  detail = detail.slice(0, 400);

  const hint =
    err.status === 401 ? 'Authentication failed - your token is invalid or expired. Re-authenticate (re-run the OAuth connect, or check the API key).'
    : err.status === 403 ? 'Permission denied - your account lacks the required permission for this action.'
    : err.status === 404 ? 'Not found - the referenced ticket / project / resource does not exist or you cannot see it.'
    : err.status === 409 ? 'Conflict - the resource already exists or is in a state that blocks this change.'
    : err.status === 422 ? 'Validation failed - the request was understood but rejected; adjust the input.'
    : err.status === 429 ? 'Rate limited - slow down and retry shortly.'
    : err.status >= 500 ? 'orboto server error - transient; retry shortly. If it persists the API may be mid-deploy.'
    : 'Request rejected.';

  return `orboto API error ${err.status}. ${hint}\nDetail: ${detail || '(no message)'}`;
}

// ORB-1817 - McpLogEntry / redactSecrets / postLogEntry live in
// mcp-instrument.ts (a leaf module) so input-schema.ts can log validation
// failures through the same instrument path without an import cycle
// (this file already imports FROM input-schema.ts).

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
  // ORB-1252 - forward the SDK's `extra` (RequestHandlerExtra) so handlers can
  // read the per-connection MCP sessionId (distinct per HTTP client even on a
  // shared server). Backward-compatible: handlers that ignore it are unaffected.
  handler: (args: TArgs, extra?: unknown) => Promise<CallToolResult>,
  // ORB-1331 - per-session/-process nudge state. When present, the first
  // tool dispatch that is not `orboto_session_start` gets the one-time
  // reminder prepended to its response. Optional so direct callers/tests
  // that don't care are unaffected.
  nudge?: NudgeState,
): (args: TArgs, extra?: unknown) => Promise<CallToolResult> {
  return async (args: TArgs, extra?: unknown): Promise<CallToolResult> => {
    const start = Date.now();
    // ORB-1331 - decide (and advance the flag) once per dispatch, before
    // the handler runs, so the "first tool call" is the first dispatch
    // regardless of its outcome. Applied to the returned result below.
    const wantsNudge = nudge ? shouldNudge(nudge, toolName) : false;
    // ORB-1471 - HARD session-start gate. When the workspace requires it,
    // refuse every tool call until `orboto_session_start` succeeds. The gate message
    // supersedes the soft nudge, so we return it directly without running the
    // handler. Disabled by default => `shouldGate` returns false and nothing
    // below changes.
    if (nudge && shouldGate(nudge, toolName)) {
      const gated = gateResult();
      void postLogEntry(client, {
        toolName,
        durationMs: Date.now() - start,
        success: false,
        errorMessage: 'session-start gate: call orboto_session_start first',
        clientHint,
      });
      return gated;
    }
    try {
      const handlerResult = await handler(args, extra);
      // ORB-1697 - the central response budget. Applied HERE, once, so it
      // covers every registered tool instead of relying on 168 handlers to
      // each stay small. Over-budget payloads come back truncated with an
      // explicit `__truncation` block + a handle for the remainder; the
      // measured sizes go into the call log either way.
      const budgeted = applyResponseBudget(toolName, handlerResult);
      const result = budgeted.result;
      // Success path - but the handler can also signal a "soft"
      // failure via { isError: true } in the result. We treat that
      // as success=false in the log so dashboards reflect actual
      // user-visible failures.
      const isError = result.isError === true;
      if (nudge) recordSessionStartResult(nudge, toolName, !isError);
      void postLogEntry(client, {
        toolName,
        durationMs: Date.now() - start,
        success: !isError,
        errorMessage: isError && result.content[0] && 'text' in result.content[0]
          ? redactSecrets(String(result.content[0].text)).slice(0, 500)
          : undefined,
        clientHint,
        responseChars: budgeted.responseChars,
        truncatedChars: budgeted.truncatedChars,
      });
      // ORB-1727 - agent-mail piggyback: the client captured the api's
      // `x-orboto-agent-mail` header on the request this tool just made.
      // Append a compact pointer while mail is pending - zero bytes when
      // the inbox is empty, and never on the messages tool itself (the
      // caller is already fetching).
      const withMail = appendMailNudge(client, toolName, result);
      return wantsNudge ? prependNudge(withMail) : withMail;
    } catch (err) {
      const durationMs = Date.now() - start;
      if (nudge) recordSessionStartResult(nudge, toolName, false);
      if (err instanceof RequiredRulesError) {
        void postLogEntry(client, { toolName, durationMs, success: false, statusCode: err.status, errorMessage: err.message, clientHint });
        return { isError: true, content: [{ type: 'text', text: err.message }], structuredContent: { errorKey: err.errorKey, reason: err.reason, ...(err.status ? { status: err.status } : {}) } };
      }
      // ORB-1174 - an OrbotoApiError carries a real HTTP status + message.
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
      // Anything else is unexpected (a bug, not an API rejection) - log
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
 * Helper for `server.ts` - wraps `server.registerTool` so call sites
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
 * Both `config` and the registerTool call use loose types - the SDK
 * has multiple overloads (with / without input schema) and threading
 * generic params through the wrapper makes TS pick the wrong overload
 * for some tools (the admin ones in this case land on the
 * no-input-schema overload). Type-correctness is enforced at the
 * original tool-config declaration site instead.
 */
/**
 * ORB-1727 - append the pending-inbox pointer to a tool result. Reads the
 * count the OrbotoClient captured from the last response header; costs
 * nothing when the inbox is empty and skips the fetch/ack tool itself.
 */
/** Exported for the ORB-1733 regression test. */
export function appendMailNudge(client: OrbotoClient, toolName: string, result: CallToolResult): CallToolResult {
  if (!client.pendingAgentMail || toolName === 'orboto_messages') return result;
  // ORB-1733: the nudge lives ONLY in a text content block. Never touch
  // structuredContent - the SDK validates it against the tool's declared
  // outputSchema, and an injected extra key fails validation and errors
  // the entire tool call for as long as mail sits unread.
  const line = `You have ${client.pendingAgentMail} unread agent message(s) - fetch them with orboto_messages.`;
  return {
    ...result,
    content: [...result.content, { type: 'text', text: line }],
  };
}

export function registerWithMetrics(
  server: McpServer,
  client: OrbotoClient,
  clientHint: string | undefined,
  // ORB-1331 - shared per-session/-process nudge state. Every tool
  // registered through this closure reads/advances the same flag, so the
  // one-time session-start reminder fires on whichever tool is called
  // first (unless it is `orboto_session_start`).
  nudge?: NudgeState,
) {
  return (toolName: string, config: ToolConfig, handler: ToolHandler): void => {
    // ORB-1692 - every raw-shape input becomes strict + alias-resolving.
    // Central here so a new tool cannot ship permissive; empty/absent
    // shapes stay untouched (they carry no fields to guard).
    let cfg = config?.inputSchema && isRawShape(config.inputSchema)
      // ORB-1817 - `client` + `clientHint` let a validation failure log
      // through the same instrument path as a handler error (Part C):
      // the SDK validates BEFORE this handler wrapper ever runs, so this
      // is the only place that sees the failure.
      ? { ...config, inputSchema: buildStrictInputSchema(toolName, config.inputSchema, client, clientHint) }
      : config;
    // ORB-1738 - every declared output shape ADVERTISES the response
    // budget's optional __truncation marker. The SDK emits
    // additionalProperties:false for output schemas, and strict clients
    // validate structuredContent against that - an over-budget response
    // carrying the (undeclared) marker was rejected wholesale
    // (list_projects failed on EVERY call). Same central place as the
    // input fix so no tool can ship an outputSchema that fights the
    // budget layer.
    if (cfg?.outputSchema && isRawShape(cfg.outputSchema)) {
      cfg = {
        ...cfg,
        // ORB-1805 - the ADVERTISED (compact, open) form; the exact
        // shape stays TruncationBlockSchema for runtime assertions.
        outputSchema: { ...cfg.outputSchema, __truncation: TruncationBlockAdvertisedSchema.optional() },
      };
    }
    // ORB-1741 - manifest diet: the wire manifest carries a one-sentence
    // summary; the full guidance is captured for orboto_help. Central
    // here so a new tool cannot ship a manifest essay by accident.
    if (typeof cfg?.description === 'string' && cfg.description.length > 0) {
      captureToolDoc(toolName, cfg.description);
      cfg = { ...cfg, description: summarizeToolDescription(toolName, cfg.description) };
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (server.registerTool as any)(
      toolName,
      cfg,
      withMetrics(client, toolName, clientHint, handler, nudge),
    );
  };
}
