/**
 * ORB-2669 - a toolset that offers nothing (`channel`) still answers the three
 * list methods and declares their capabilities. The SDK installs a list handler
 * only when something is registered, so a client that lists without checking
 * capabilities (Kimi Code) got -32601 and dropped the server.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { printableLine } from './tools/printable-text.js';

/** Declared at construction: the SDK refuses a request handler whose capability is not declared. */
export const EMPTY_SURFACE_CAPABILITIES = { tools: {}, prompts: {}, resources: {} } as const;

/** Empty lists, and the not-found answers the SDK gives for a name nothing registered. */
export function registerEmptySurfaces(server: McpServer): void {
  const low = server.server;
  low.setRequestHandler(ListToolsRequestSchema, () => ({ tools: [] }));
  low.setRequestHandler(CallToolRequestSchema, (req) => ({
    content: [{ type: 'text' as const, text: new McpError(ErrorCode.InvalidParams, `Tool ${printableLine(req.params.name, 200)} not found`).message }],
    isError: true,
  }));
  low.setRequestHandler(ListPromptsRequestSchema, () => ({ prompts: [] }));
  low.setRequestHandler(GetPromptRequestSchema, (req) => {
    throw new McpError(ErrorCode.InvalidParams, `Prompt ${printableLine(req.params.name, 200)} not found`);
  });
  low.setRequestHandler(ListResourcesRequestSchema, () => ({ resources: [] }));
  low.setRequestHandler(ListResourceTemplatesRequestSchema, () => ({ resourceTemplates: [] }));
  low.setRequestHandler(ReadResourceRequestSchema, (req) => {
    throw new McpError(ErrorCode.InvalidParams, `Resource ${printableLine(req.params.uri, 500)} not found`);
  });
}
