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
import type { OrbitClient } from './orbit-client.js';

interface LogEntry {
  toolName: string;
  durationMs: number;
  success: boolean;
  errorMessage?: string;
  clientHint?: string;
}

async function postLogEntry(client: OrbitClient, entry: LogEntry): Promise<void> {
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
  client: OrbitClient,
  toolName: string,
  clientHint: string | undefined,
  handler: (args: TArgs) => Promise<CallToolResult>,
): (args: TArgs) => Promise<CallToolResult> {
  return async (args: TArgs): Promise<CallToolResult> => {
    const start = Date.now();
    try {
      const result = await handler(args);
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
          ? String(result.content[0].text).slice(0, 500)
          : undefined,
        clientHint,
      });
      return result;
    } catch (err) {
      // Hard exception path — handler threw. Log and re-throw so
      // the MCP runtime renders an isError response.
      void postLogEntry(client, {
        toolName,
        durationMs: Date.now() - start,
        success: false,
        errorMessage: (err instanceof Error ? err.message : String(err)).slice(0, 500),
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
 *
 * ORB-585 — every tool registered with the canonical `orboto_*` name
 * also gets a `orboto_*` legacy alias that points to the same handler.
 * The alias's description is prefixed with [DEPRECATED ALIAS] so
 * clients that surface tool descriptions show the migration hint.
 * Metrics rows log under the actually-invoked name so dashboards can
 * track legacy-vs-canonical adoption. Removed in v1.0 (separate
 * cleanup ticket).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ToolConfig = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ToolHandler = (args: any) => Promise<CallToolResult>;

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
  client: OrbitClient,
  clientHint: string | undefined,
) {
  return (canonicalName: string, config: ToolConfig, handler: ToolHandler): void => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (server.registerTool as any)(
      canonicalName,
      config,
      withMetrics(client, canonicalName, clientHint, handler),
    );

    // ORB-585 — legacy `orboto_*` alias for one major release. Skipped
    // when the canonical name doesn't carry the new prefix (defensive;
    // every current call site uses `orboto_*`).
    if (canonicalName.startsWith('orboto_')) {
      const legacyName = `orboto_${canonicalName.slice('orboto_'.length)}`;
      const legacyDesc = config?.description
        ? `[DEPRECATED ALIAS — use ${canonicalName} instead; this name is removed in v1.0] ${config.description}`
        : `[DEPRECATED ALIAS — use ${canonicalName} instead; this name is removed in v1.0]`;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (server.registerTool as any)(
        legacyName,
        { ...config, description: legacyDesc },
        withMetrics(client, legacyName, clientHint, handler),
      );
    }
  };
}
