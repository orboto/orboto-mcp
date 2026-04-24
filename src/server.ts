/**
 * ORB-244 Phase A — MCP server factory.
 *
 * Builds an `McpServer` with the registered tool set + a handle to
 * the Orbit REST client. Transport is picked by the process entry
 * point (`index.ts`) based on `ORBIT_MCP_TRANSPORT=stdio|http`.
 *
 * Keeping the server factory transport-agnostic means `server.ts` is
 * the same object whether we ship stdio for Local-Proxy (Phase G
 * `@orbit/mcp-cli`) or HTTP-SSE for Self-Hosted-inline.
 *
 * Tool registrations stay in this file so adding a new tool in
 * Phase B is one diff here + one new file in `tools/`. Phase D will
 * add `registerResource` / `registerPrompt` calls here too.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { OrbitClient, type OrbitClientConfig } from './orbit-client.js';
import { listProjectsToolConfig, makeListProjectsHandler } from './tools/list-projects.js';

export interface BuildServerOptions extends OrbitClientConfig {
  /** Optional — passed through to McpServer metadata. Clients
   *  sometimes surface this in their UI. */
  clientDescription?: string;
}

export function buildOrbitMcpServer(opts: BuildServerOptions): McpServer {
  const client = new OrbitClient(opts);

  const server = new McpServer(
    { name: 'orbit', version: '0.51.0' },
    {
      // `instructions` appears in the system-prompt-style block some
      // MCP clients inject before the user's first message. Keep it
      // short + specific; avoid walls of text.
      instructions: [
        'Orbit is a ticket + project management system.',
        'Use `orbit_list_projects` first to discover what the user can see.',
        'Ticket keys look like `PROJ-123`; the first segment is the project key.',
        'All writes respect the caller\'s project-level permissions — a 403 means the API rejected the write, not the MCP server.',
      ].join(' '),
    },
  );

  // Tools — single dispatch point for future registrations. Each
  // tool file owns its input/output schema; the server just glues
  // names to handlers.
  server.registerTool(
    'orbit_list_projects',
    listProjectsToolConfig,
    makeListProjectsHandler(client),
  );

  return server;
}
