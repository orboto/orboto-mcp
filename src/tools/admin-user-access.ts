/**
 * ORB-3147 - `orboto_admin_user_access`: the access email for up to 100 accounts (7-day set-password link, SSO hint, sign-in page,
 * support address) and the 1-hour password reset link for one account, by email or id. Both mint a credential, so an OAuth connection
 * never reaches them; an API key whose owner has a second factor must list admin:users:write.
 */
import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { OrbotoApiError, type OrbotoClient } from '../orboto-client.js';
import type { AccessEmailBulkResponse, AccessEmailResult } from './admin-user-access-result.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const adminUserAccessToolConfig = {
  title: 'Access email (admin)',
  description: 'Access email to accounts, or a reset link to one (admin:users:write). email: up to 100 accounts by email or id, each mailed a set-password link valid 7 days (none under SSO enforcement, then the provider is named), the sign-in page and the support address; bots, deactivated and placeholder accounts and accounts mailed in the last 5 minutes are skipped with the reason. reset: one account, a password reset link valid 1 hour. When no mail went out the link stays out of the answer: a person hands one over from Admin -> Users. Refused over OAuth; an API key whose owner has a second factor must list admin:users:write.',
  inputSchema: z.object({
    action: z.enum(['email', 'reset']),
    users: z.array(z.string()).max(100),
  }).shape,
  annotations: { readOnlyHint: false, destructiveHint: true },
};

interface UserRow { id: string; email: string }

function refused(err: unknown): never {
  if (err instanceof OrbotoApiError && err.status === 403) {
    let reason = 'needs admin:users:write';
    try { reason = (JSON.parse(err.body) as { error?: string }).error ?? reason; } catch { reason = err.body || reason; }
    throw new Error(`Refused: ${reason} An OAuth connection never sends these; use an API key (listing admin:users:write when its owner has a second factor) or Admin -> Users.`);
  }
  throw err as Error;
}

async function resolveUser(client: OrbotoClient, ref: string): Promise<string | null> {
  if (UUID.test(ref)) return ref;
  const page = await client.get<{ items: UserRow[] }>(`/admin/users?${new URLSearchParams({ search: ref.slice(0, 320), limit: '25', hideGhosts: 'false' })}`).catch(refused);
  return page.items.find((u) => u.email.toLowerCase() === ref.toLowerCase())?.id ?? null;
}

const HAND_OVER = 'the link stays out of this transcript: a person gets one to hand over on Admin -> Users -> Security or with `orboto admin user reset-link <email>` in their own terminal';
const NEEDS_PERSON = 'no mail was delivered and the link goes only to a person, so none was kept: a person sends it from Admin -> Users, or set up outgoing mail';

function outcomeLine(r: AccessEmailResult): string {
  const who = r.email ?? r.userId;
  if (r.status === 'skipped' && r.reason === 'needs_person') return `- ${who}: NOT sent; ${NEEDS_PERSON}`;
  if (r.status === 'skipped') return `- ${who}: skipped (${r.reason}${r.retryAfterSeconds ? `, retry in ${r.retryAfterSeconds}s` : ''})`;
  const link = r.linkIncluded ? `set-password link valid until ${r.expiresAt}` : `no link, sign in with ${r.ssoProvider}`;
  if (r.status === 'sent') return `- ${who}: sent, ${link}${r.ssoProvider && r.linkIncluded ? `, SSO hint ${r.ssoProvider}` : ''}`;
  if (r.reason === 'error') return `- ${who}: NOT delivered, the send failed on the server`;
  if (!r.linkIncluded) return `- ${who}: NOT delivered; no link was minted, the account signs in with ${r.ssoProvider}`;
  return `- ${who}: NOT delivered; ${HAND_OVER}`;
}

export function makeAdminUserAccessHandler(client: OrbotoClient) {
  return async ({ action, users }: { action: 'email' | 'reset'; users: string[] }): Promise<CallToolResult> => {
    if (action === 'reset') {
      if (users.length !== 1) throw new Error('reset takes exactly one account.');
      const id = await resolveUser(client, users[0]);
      if (!id) throw new Error(`No account with email or id "${users[0]}".`);
      const answer = await client.post<{ sent: boolean; expiresAt: string; resetUrl?: string }>(`/admin/users/${id}/password-reset-link`, {}).catch((err: unknown) => {
        if (err instanceof OrbotoApiError && err.status === 422 && err.body.includes('errors.users.account_link_needs_person')) return null;
        return refused(err);
      });
      if (!answer) return { content: [{ type: 'text', text: `No reset link: ${NEEDS_PERSON}.` }], structuredContent: { userId: id, sent: false, kept: false } };
      const { sent, expiresAt } = answer;
      const text = sent ? `Reset link mailed to ${users[0]}, valid until ${expiresAt}.` : `No mail went out; ${HAND_OVER}.`;
      return { content: [{ type: 'text', text }], structuredContent: { userId: id, sent, expiresAt } };
    }
    const ids: string[] = [];
    const unknown: string[] = [];
    for (const ref of users) {
      const id = await resolveUser(client, ref);
      if (id) ids.push(id); else unknown.push(ref);
    }
    if (users.length === 0) throw new Error('Name at least one account by email or id.');
    const res: AccessEmailBulkResponse = ids.length
      ? await client.post<AccessEmailBulkResponse>('/admin/users/access-email', { userIds: ids }).catch(refused)
      : { results: [], sent: 0, notSent: 0, skipped: 0 };
    const lines = [
      `Access email: ${res.sent} sent, ${res.notSent} not delivered, ${res.skipped + unknown.length} skipped.`,
      ...res.results.map(outcomeLine),
      ...unknown.map((ref) => `- ${ref}: skipped (no such account)`),
    ];
    const results = res.results.map(({ resetUrl: _withheld, ...rest }) => rest);
    return { content: [{ type: 'text', text: lines.join('\n') }], structuredContent: { ...res, results, unknown } };
  };
}
