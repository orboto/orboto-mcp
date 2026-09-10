/**
 * ORB-311 Phase F - wrap a tool handler so every dispatch logs to
 * `/admin/mcp/instrument` after the call completes.
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
  handler: (args: TArgs, extra?: unknown) => Promise<CallToolResult>,
  nudge?: NudgeState,
): (args: TArgs, extra?: unknown) => Promise<CallToolResult> {
  return async (args: TArgs, extra?: unknown): Promise<CallToolResult> => {
    const start = Date.now();
    const wantsNudge = nudge ? shouldNudge(nudge, toolName) : false;
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
      const budgeted = applyResponseBudget(toolName, handlerResult);
      const result = budgeted.result;
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
      const withMail = appendMailNudge(client, toolName, result);
      return wantsNudge ? prependNudge(withMail) : withMail;
    } catch (err) {
      const durationMs = Date.now() - start;
      if (nudge) recordSessionStartResult(nudge, toolName, false);
      if (err instanceof RequiredRulesError) {
        void postLogEntry(client, { toolName, durationMs, success: false, statusCode: err.status, errorMessage: err.message, clientHint });
        return { isError: true, content: [{ type: 'text', text: err.message }], structuredContent: { errorKey: err.errorKey, reason: err.reason, ...(err.status ? { status: err.status } : {}) } };
      }
      if (err instanceof OrbotoApiError) {
        const text = formatApiError(err);
        void postLogEntry(client, { toolName, durationMs, success: false, statusCode: err.status, errorMessage: redactSecrets(text).slice(0, 500), clientHint });
        const errResult: CallToolResult = { isError: true, content: [{ type: 'text', text }] };
        return wantsNudge ? prependNudge(errResult) : errResult;
      }
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
  nudge?: NudgeState,
) {
  return (toolName: string, config: ToolConfig, handler: ToolHandler): void => {
    let cfg = config?.inputSchema && isRawShape(config.inputSchema)
      ? { ...config, inputSchema: buildStrictInputSchema(toolName, config.inputSchema, client, clientHint) }
      : config;
    if (cfg?.outputSchema && isRawShape(cfg.outputSchema)) {
      cfg = {
        ...cfg,
        outputSchema: { ...cfg.outputSchema, __truncation: TruncationBlockAdvertisedSchema.optional() },
      };
    }
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
