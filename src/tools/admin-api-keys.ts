/**
 * ORB-2931 - `orboto_admin_api_key_list` and `orboto_admin_api_key_revoke`: an admin lists every API key and revokes one by id.
 * A found key value is never a tool argument, because arguments land in client transcripts; it goes through
 * `orboto admin api-keys revoke --key-stdin` or Admin -> API keys.
 */
import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { OrbotoApiError, type OrbotoClient } from '../orboto-client.js';
import type { AdminApiKeyRevokeResult } from './admin-api-key-result.js';

const SORTS = ['requests', 'lastUsed', 'name', 'owner'] as const;
const BY_VALUE = 'A found key value goes through `orboto admin api-keys revoke --key-stdin` or Admin -> API keys, never a tool argument.';

interface KeyRow {
  id: string;
  name: string;
  keyPrefix: string;
  userId: string;
  userName: string | null;
  userEmail: string | null;
  requestCount: number;
  isAgent: boolean;
  lastUsedAt: string | null;
  expiresAt: string | null;
  createdAt: string;
  flags: string[];
}

export const adminApiKeyListToolConfig = {
  title: 'List API keys (admin)',
  description: `List every API key with owner, prefix, requests, last use, expiry and flags (admin:audit:read). \`owner\` keeps one owner's keys by exact email. Revoke one with orboto_admin_api_key_revoke. ${BY_VALUE}`,
  inputSchema: z.object({
    owner: z.string().max(320).optional(),
    search: z.string().max(200).optional(),
    sort: z.enum(SORTS).optional(),
    limit: z.number().int().min(1).max(200).optional(),
  }).shape,
  annotations: { readOnlyHint: true, idempotentHint: true },
};

export const adminApiKeyRevokeToolConfig = {
  title: 'Revoke an API key (admin)',
  description: `Revoke any account's API key by id (admin:users:write): requests with it get 401 at once, the revoke is audited and the owner is told, with \`reason\` when given. Ids come from orboto_admin_api_key_list. ${BY_VALUE}`,
  inputSchema: z.object({
    id: z.guid(),
    reason: z.string().max(500).optional(),
  }).shape,
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
};

function refused(slug: string): (err: unknown) => never {
  return (err) => {
    if (err instanceof OrbotoApiError && err.status === 403) {
      throw new Error(`This needs ${slug} on this workspace; an OAuth connection never manages API keys.`);
    }
    if (err instanceof OrbotoApiError && err.status === 404) throw new Error('No API key with that id: it is revoked already or never existed.');
    throw err as Error;
  };
}

function owner(row: { userName: string | null; userEmail: string | null }): string {
  return `${row.userName ?? '-'} <${row.userEmail ?? '-'}>`;
}

export function makeAdminApiKeyListHandler(client: OrbotoClient) {
  return async (args: { owner?: string; search?: string; sort?: (typeof SORTS)[number]; limit?: number }): Promise<CallToolResult> => {
    const query = new URLSearchParams({ sort: args.sort ?? 'requests' });
    const search = args.owner?.trim() || args.search?.trim();
    if (search) query.set('search', search);
    const page = await client.get<{ totalRequests: number; keys: KeyRow[] }>(`/admin/api-keys?${query.toString()}`).catch(refused('admin:audit:read'));
    const wanted = args.owner?.trim().toLowerCase();
    const matching = wanted ? page.keys.filter((k) => (k.userEmail ?? '').toLowerCase() === wanted) : page.keys;
    const keys = matching.slice(0, args.limit ?? 50);
    const text = keys.length
      ? [
        ...keys.map((k) => `- ${k.id} "${k.name}" (${k.keyPrefix}) of ${owner(k)}: ${k.requestCount} requests, last used ${k.lastUsedAt ?? 'never'}, expires ${k.expiresAt ?? 'never'}${k.isAgent ? ', agent' : ''}${k.flags.length ? `, ${k.flags.join(', ')}` : ''}`),
        ...(matching.length > keys.length ? [`(${matching.length - keys.length} more: raise limit or narrow with owner or search)`] : []),
      ].join('\n')
      : 'No API keys matched.';
    return { content: [{ type: 'text', text }], structuredContent: { count: keys.length, total: matching.length, keys } };
  };
}

export function makeAdminApiKeyRevokeHandler(client: OrbotoClient) {
  return async (args: { id: string; reason?: string }): Promise<CallToolResult> => {
    const reason = args.reason?.trim();
    const result = await client.post<AdminApiKeyRevokeResult>(`/admin/api-keys/${args.id}/revoke`, reason ? { reason } : {}).catch(refused('admin:users:write'));
    const { key } = result;
    const text = `Revoked "${key.name}" (${key.keyPrefix}) of ${owner(key)}. Requests with it now get 401; the owner was told. Replace it wherever it was used.`;
    return { content: [{ type: 'text', text }], structuredContent: { ...result } };
  };
}
