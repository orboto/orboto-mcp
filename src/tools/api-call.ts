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
import { boundedRecord } from '../zod-bounds.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { OrbotoClient } from '../orboto-client.js';
import { mcpInstanceToken } from './shared.js';

interface ProxyEnvelope {
  status: number;
  contentType: string | null;
  body: unknown;
  encoding: 'json' | 'utf8' | 'base64';
  truncated: boolean;
  matchedRoute: string;
}

/** ORB-3068 - mirror of VAULT_PLAINTEXT_ROUTES in apps/api/src/services/vault-passthrough.ts (drift test in api-call.test.ts); refused here too, so an older server never answers one. */
export const VAULT_PLAINTEXT_ROUTES = [
  'POST /credentials/:id/reveal',
  'POST /credentials/:id/totp',
  'POST /credentials/:id/file',
  'POST /credentials/browser-login',
  'POST /credentials/:id/browser-login/recovery-code',
  'POST /credentials/browser-login/passkey',
] as const;

const VAULT_PLAINTEXT_PATHS = VAULT_PLAINTEXT_ROUTES.map((route) => new RegExp(`^${route.split(' ')[1].replace(/:[^/]+/g, '[^/]+')}$`, 'i'));

export const VAULT_PASSTHROUGH_REFUSAL = 'HTTP 403 errors.credential.passthrough_refused - a vault secret never leaves through orboto_api_call, '
  + 'where it would land in a model transcript. Use the credential without seeing it: `orboto ssh --credential KEY` or '
  + '`orboto credential ssh-agent KEY` for an SSH key, `orboto browser login --credential KEY` for a site login. '
  + 'A person who needs the value reveals it on the credential page.';

function normalisedPath(path: string): string {
  const segments = path.split('/').map((segment) => segment.replace(/;.*$/, '')).filter((segment) => segment !== '' && segment !== '.');
  return `/${segments.join('/')}`;
}

/** Every spelling a server could resolve: the raw path and its percent-decoded form, each with empty, `.` and `;` parts dropped. */
function pathCandidates(path: string): string[] {
  let decoded = path;
  try { decoded = decodeURIComponent(path); } catch { /* keep the raw spelling */ }
  return [normalisedPath(path), normalisedPath(decoded)];
}

export function isVaultPlaintextPath(path: string): boolean {
  return pathCandidates(path).some((candidate) => VAULT_PLAINTEXT_PATHS.some((pattern) => pattern.test(candidate)));
}

export const apiCallToolConfig = {
  title: 'Call a REST endpoint',
  description:
    'Run one REST API request: the escape hatch for any endpoint without a named tool. '
    + 'Find the endpoint + its schema with `orboto_api_search` first. Runs with YOUR permissions '
    + 'only (the API enforces them server-side); the response is an envelope carrying the inner '
    + 'HTTP status + body verbatim, so react to a 403/404/422 as data. Auth/OAuth/setup/webhook '
    + 'paths are blocked at the proxy. Over an OAuth connection, API keys, OAuth clients, sign-in factors and passwords '
    + 'need the web login (403 errors.auth.oauth_credential_route_refused). '
    + 'A vault route that answers with a plaintext or a second factor (reveal, totp, file, browser-login) is refused '
    + '(403 errors.credential.passthrough_refused); credential metadata stays readable. '
    + 'Prefer named tools when one exists - they are more ergonomic.',
  inputSchema: z.object({
    method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']),
    path: z.string().min(1).max(500)
      .describe('Route path, e.g. "/projects/<uuid>/milestones". No query string.'),
    query: boundedRecord(z.string(), z.union([z.string(), z.number(), z.boolean(), z.array(z.string()).max(200)]), 100).optional(),
    body: z.union([z.record(z.string(), z.unknown()), z.array(z.unknown()), z.string(), z.number(), z.boolean()]).optional()
      .describe('A real object/array, not a string.'),
  }).shape,
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
};

export function makeApiCallHandler(client: OrbotoClient) {
  return async (input: {
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
    path: string;
    query?: Record<string, string | number | boolean | string[]>;
    body?: unknown;
  }, extra?: unknown): Promise<CallToolResult> => {
    if (isVaultPlaintextPath(input.path)) {
      return { isError: true, content: [{ type: 'text', text: VAULT_PASSTHROUGH_REFUSAL }] };
    }
    let body = input.body;
    if (typeof body === 'string') {
      try { body = JSON.parse(body); } catch { /* pass through */ }
    }
    const envelope = await client.post<ProxyEnvelope>('/system/api-proxy', {
      method: input.method,
      path: input.path,
      ...(input.query ? { query: input.query } : {}),
      ...(body !== undefined ? { body } : {}),
    }, { instanceToken: mcpInstanceToken(undefined, extra as { sessionId?: string } | undefined) });

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
