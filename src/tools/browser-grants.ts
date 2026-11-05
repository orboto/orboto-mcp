/** ORB-2837 - `orboto_browser_grants`: list, grant and revoke the grants of a paired browser. */
import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { OrbotoApiError, type OrbotoClient } from '../orboto-client.js';

const LIFETIMES = ['session', 'ticket', '8h', '1d', '7d', '30d', 'forever'] as const;

interface GrantRow {
  id: string;
  pairingId: string;
  browserName: string;
  grantorEmail: string;
  granteeEmail: string;
  lifetime: (typeof LIFETIMES)[number];
  expiresAt: string | null;
  sessionName: string | null;
  ticketKey: string | null;
  lastUsedAt: string | null;
  useCount: number;
  endReason: string | null;
  active: boolean;
  canRevoke: boolean;
}

export const browserGrantsToolConfig = {
  title: 'Browser grants',
  description:
    'List, grant or revoke the use of your paired browser by an agent account you own, without the Allow click. A grant to yourself or for a closed ticket is refused (422): your own sessions approve themselves. The grantee acts in the signed-in browser unwatched for the lifetime (session, ticket: until that work session ends, 8h to 30d, forever; a session or ticket grant lapses after 8h without a start); grant needs id = the pairing (orboto browser pairings), grantee and lifetime; revoke needs id = the grant. Only the browser\'s owner grants; the grantor or admin:system:write revokes; all lists every grant (admin:system:read).',
  inputSchema: z.object({
    action: z.enum(['list', 'grant', 'revoke']).optional(),
    id: z.string().uuid().optional(),
    grantee: z.string().optional(),
    lifetime: z.enum(LIFETIMES).optional(),
    ticketKey: z.string().optional(),
    all: z.boolean().optional(),
  }).shape,
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
};

type Args = {
  action?: 'list' | 'grant' | 'revoke';
  id?: string;
  grantee?: string;
  lifetime?: (typeof LIFETIMES)[number];
  ticketKey?: string;
  all?: boolean;
};

const WARNING = 'Until it ends, the account can act in that signed-in browser without anyone watching, with every login the browser holds; its session tab group, the host allowlist, the confirmation before irreversible steps, Stop in the side panel and the audit still apply. Revoke with action revoke, `orboto browser revoke-grant <id>` or Account -> Security -> Browsers.';

function ends(grant: GrantRow): string {
  if (!grant.active) return `ended (${grant.endReason ?? 'expired'})`;
  if (grant.expiresAt && grant.lifetime === 'session') return `until the session that starts it first ends (lapses ${grant.expiresAt} unused)`;
  if (grant.expiresAt && grant.lifetime === 'ticket') return `until the work on ${grant.ticketKey ?? 'its ticket'} ends (lapses ${grant.expiresAt} unused)`;
  if (grant.expiresAt) return `until ${grant.expiresAt}`;
  if (grant.lifetime === 'session') return grant.sessionName ? `until session "${grant.sessionName}" ends` : 'until its next session ends';
  if (grant.lifetime === 'ticket') return `until the work on ${grant.ticketKey ?? 'its ticket'} ends`;
  return 'until revoked';
}

function line(grant: GrantRow): string {
  return `${grant.id} ${grant.browserName} of ${grant.grantorEmail} -> ${grant.granteeEmail}: ${grant.lifetime}, ${ends(grant)}, used ${grant.useCount}x${grant.lastUsedAt ? `, last ${grant.lastUsedAt}` : ''}`;
}

function refused(err: unknown): never {
  if (err instanceof OrbotoApiError && err.status === 403) throw new Error('Listing every grant needs admin:system:read.');
  if (err instanceof OrbotoApiError && err.status === 422) {
    throw new Error(err.body.includes('browser_grant_ticket_closed')
      ? 'That ticket is already closed, so there is no work left to lend the browser for. Pick an open ticket or another lifetime.'
      : 'A grant to yourself changes nothing: your own sessions approve themselves through the login pairing. Grant the browser to an agent account you own.');
  }
  if (err instanceof OrbotoApiError && err.status === 404) throw new Error(`Not found: ${err.message}. Only the browser's owner grants it, to an agent account they own; only the grantor or an admin revokes.`);
  throw err as Error;
}

export function makeBrowserGrantsHandler(client: OrbotoClient) {
  return async (args: Args): Promise<CallToolResult> => {
    const action = args.action ?? 'list';
    if (action === 'grant') {
      if (!args.id || !args.grantee || !args.lifetime) throw new Error('grant needs id (the paired browser, orboto browser pairings), grantee (email or id) and lifetime.');
      if (args.lifetime === 'ticket' && !args.ticketKey) throw new Error('lifetime ticket needs ticketKey: the grant ends when the grantee\'s work session on that ticket ends.');
      const grant = await client.post<GrantRow>('/agents/browser-grants', {
        pairingId: args.id, grantee: args.grantee, lifetime: args.lifetime, ...(args.ticketKey ? { ticketKey: args.ticketKey } : {}),
      }).catch(refused);
      const text = `Granted: ${line(grant)}.${grant.lifetime === 'session' ? '' : `\n${WARNING}`}`;
      return { content: [{ type: 'text', text }], structuredContent: { action, grant } };
    }
    if (action === 'revoke') {
      if (!args.id) throw new Error('revoke needs id: the grant (action list shows the ids).');
      const grant = await client.delete<GrantRow>(`/agents/browser-grants/${args.id}`).catch(refused);
      return { content: [{ type: 'text', text: `Revoked: ${line(grant)}. The grant ended now: a browser connected to orboto closes the connections it opened at once, one that is not closes them when it connects again; the next start asks again.` }], structuredContent: { action, grant } };
    }
    const query = new URLSearchParams({ scope: args.all ? 'all' : 'mine', limit: '50' });
    if (args.id) query.set('pairingId', args.id);
    const page = await client.get<{ items: GrantRow[]; nextCursor: string | null }>(`/agents/browser-grants?${query.toString()}`).catch(refused);
    const text = page.items.length
      ? `${page.items.map(line).join('\n')}${page.nextCursor ? '\n(more grants: orboto browser grants --limit 100)' : ''}`
      : 'No browser grants. The Allow dialog of the orboto extension or `orboto browser grant <pairing> --to <account> --for <lifetime>` creates one.';
    return { content: [{ type: 'text', text }], structuredContent: { action, items: page.items, nextCursor: page.nextCursor } };
  };
}
