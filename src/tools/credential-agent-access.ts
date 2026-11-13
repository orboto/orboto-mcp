/** ORB-3078 - `orboto_credential_agent_access`: reads the agent identities allowed to reveal one credential; only a person edits the list (credential page, `orboto credential agent-access`). */
import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { OrbotoApiError, type OrbotoClient } from '../orboto-client.js';
import type { CredentialAgentAccess } from './credential-agent-access-result.js';

export const credentialAgentAccessToolConfig = {
  title: 'Credential agent access',
  description:
    'Read which agents may reveal a credential: list shows the entries, candidates the accounts that can reveal it with their agent keys and OAuth clients (q searches name or e-mail). An agent key or bot account without an entry gets 403; people never need one. credential takes a key or id. Needs manage. Read only: a person edits the list on the credential page or with `orboto credential agent-access`, never a model.',
  inputSchema: z.object({
    action: z.enum(['list', 'candidates']).optional(),
    credential: z.string(),
    q: z.string().max(100).optional(),
  }).shape,
  annotations: { readOnlyHint: true, idempotentHint: true },
};

type Args = {
  action?: 'list' | 'candidates';
  credential: string;
  q?: string;
};

interface Candidate {
  userId: string; name: string; email: string; isBot: boolean;
  agentKeys: Array<{ id: string; name: string; keyPrefix: string }>;
  oauthClients?: Array<{ clientId: string; clientName: string }>;
}

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function entryLine(entry: CredentialAgentAccess): string {
  const client = entry.apiKeyId ? `key "${entry.apiKeyName ?? entry.apiKeyId}" (${entry.apiKeyPrefix ?? '?'})` : entry.oauthClientId ? `OAuth client ${entry.oauthClientName ?? entry.oauthClientId}` : 'any key or client';
  const purposes = entry.purposes.length ? entry.purposes.join(', ') : 'every purpose';
  return `${entry.id} ${entry.agentName ?? entry.agentEmail ?? entry.agentUserId}${entry.agentIsBot ? ' (bot)' : ''}: ${client}, ${purposes}${entry.source === 'audit_seed' ? ', seeded from the reveal audit' : ''}`;
}

export function candidateLine(c: Candidate): string {
  const keys = c.agentKeys.map((k) => `\n  key ${k.id} "${k.name}" (${k.keyPrefix})`).join('');
  const clients = (c.oauthClients ?? []).map((o) => `\n  OAuth client ${o.clientId} "${o.clientName}"`).join('');
  return `${c.userId} ${c.name} <${c.email}>${c.isBot ? ' (bot)' : ''}${keys}${clients}`;
}

function refused(err: unknown): never {
  if (err instanceof OrbotoApiError && err.status === 404) throw new Error(`Not found: ${err.message}. The list needs manage on the credential.`);
  throw err as Error;
}

async function credentialId(client: OrbotoClient, keyOrId: string): Promise<string> {
  if (GUID.test(keyOrId)) return keyOrId;
  const page = await client.get<{ items: Array<{ id: string; key: string }> }>(`/credentials?key=${encodeURIComponent(keyOrId)}&limit=10`);
  const hit = page.items.find((c) => c.key.toLowerCase() === keyOrId.toLowerCase());
  if (!hit) throw new Error(`No credential with key ${keyOrId} that you can see.`);
  return hit.id;
}

export function makeCredentialAgentAccessHandler(client: OrbotoClient) {
  return async (args: Args): Promise<CallToolResult> => {
    const action = args.action ?? 'list';
    const id = await credentialId(client, args.credential);
    if (action === 'candidates') {
      const query = args.q?.trim() ? `?q=${encodeURIComponent(args.q.trim())}` : '';
      const items = await client.get<Candidate[]>(`/credentials/${id}/agent-access/candidates${query}`).catch(refused);
      const text = items.length
        ? items.map(candidateLine).join('\n')
        : 'No bot account or agent key that can reveal this credential matches.';
      return { content: [{ type: 'text', text }], structuredContent: { action, items } };
    }
    const items = await client.get<CredentialAgentAccess[]>(`/credentials/${id}/agent-access`).catch(refused);
    const text = items.length ? items.map(entryLine).join('\n') : 'No agent may reveal this credential; people reveal it directly.';
    return { content: [{ type: 'text', text }], structuredContent: { action, items } };
  };
}
