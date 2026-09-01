/**
 * ORB-1519 - `orboto_api_call`: the execute half of the Code-Mode
 * escape hatch (epic ORB-1517).
 *
 * Wraps `POST /system/api-proxy`, which dispatches the described
 * request through the API's full auth + permission + validation chain
 * with the caller's own bearer. The inner status/body come back as data
 * (the envelope), so a 403 tells the model it lacks a permission
 * instead of surfacing as an opaque tool failure.
 */
import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { OrbotoClient } from '../orboto-client.js';

interface ProxyEnvelope {
  status: number;
  contentType: string | null;
  body: unknown;
  encoding: 'json' | 'utf8' | 'base64';
  truncated: boolean;
  matchedRoute: string;
}

export const apiCallToolConfig = {
  title: 'Call any orboto REST endpoint',
  description:
    'Execute one REST API request - the escape hatch for every endpoint without a named tool. '
    + 'Find the endpoint + its schema with `orboto_api_search` first. Runs with YOUR permissions '
    + 'only (the API enforces them server-side); the response is an envelope carrying the inner '
    + 'HTTP status + body verbatim, so react to a 403/404/422 as data. Auth/OAuth/setup/webhook '
    + 'paths are blocked at the proxy. Prefer named tools when one exists - they are more ergonomic.',
  inputSchema: z.object({
    method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']),
    path: z.string().min(1).max(500)
      .describe('Route path, e.g. "/projects/<uuid>/milestones". No query string.'),
    query: z.record(z.union([z.string(), z.number(), z.boolean(), z.array(z.string())])).optional()
      .describe('Query parameters as an object.'),
    // ORB-1710 - typed union, NOT z.unknown(): a typeless argument is
    // serialized as a STRING by real MCP clients (the OCP-540 class),
    // which used to reach the inner route without a JSON content type
    // and 415. The union renders a typed anyOf so clients send real
    // JSON; the handler still parses a string arrival as belt-and-braces.
    body: z.union([z.record(z.unknown()), z.array(z.unknown()), z.string(), z.number(), z.boolean()]).optional()
      .describe('JSON body - a real object/array, not a stringified one.'),
  }).shape,
  // Dispatches arbitrary methods - never advertise as read-only.
  annotations: { readOnlyHint: false },
};

export function makeApiCallHandler(client: OrbotoClient) {
  return async (input: {
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
    path: string;
    query?: Record<string, string | number | boolean | string[]>;
    body?: unknown;
  }): Promise<CallToolResult> => {
    // ORB-1710 - belt-and-braces for clients that still stringify the
    // body: a string that parses as JSON is un-stringified here, so the
    // proxy receives real JSON even against an older API without the
    // server-side coercion. An unparseable string passes through and
    // gets the proxy's clear 400.
    let body = input.body;
    if (typeof body === 'string') {
      try { body = JSON.parse(body); } catch { /* pass through */ }
    }
    const envelope = await client.post<ProxyEnvelope>('/system/api-proxy', {
      method: input.method,
      path: input.path,
      ...(input.query ? { query: input.query } : {}),
      ...(body !== undefined ? { body } : {}),
    });

    const bodyText = envelope.encoding === 'json'
      ? JSON.stringify(envelope.body, null, 1)
      : String(envelope.body ?? '');
    const truncNote = envelope.truncated ? ' (body truncated by the proxy cap)' : '';
    const okNote = envelope.status >= 400
      ? ' - the API rejected the inner request; read the body for why (403 = missing permission).'
      : '';
    return {
      content: [{
        type: 'text',
        text: `HTTP ${envelope.status} ${envelope.matchedRoute}${truncNote}${okNote}\n${bodyText}`,
      }],
      structuredContent: envelope as unknown as Record<string, unknown>,
    };
  };
}
