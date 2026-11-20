/** ORB-3147 - `orboto_admin_user_access`: emails resolve to ids, the access email goes out in one bulk call, the reset link to one account, and refusals read plainly. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OrbotoClient } from '../orboto-client.js';
import { adminUserAccessToolConfig, makeAdminUserAccessHandler } from './admin-user-access.js';

afterEach(() => { vi.restoreAllMocks(); });

const ANNA = '11111111-1111-4111-8111-111111111111';
const BOT = '22222222-2222-4222-8222-222222222222';

function stub(replies: Record<string, { status?: number; json: unknown }>) {
  const calls: Array<{ method: string; path: string; body?: unknown }> = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    const u = new URL(url.toString());
    const method = init?.method ?? 'GET';
    calls.push({ method, path: `${u.pathname}${u.search}`, body: init?.body ? JSON.parse(init.body as string) : undefined });
    const reply = replies[`${method} ${u.pathname}`];
    if (!reply) throw new Error(`unexpected ${method} ${u.pathname}`);
    const status = reply.status ?? 200;
    return { ok: status < 400, status, statusText: 'x', headers: new Headers(), json: async () => reply.json, text: async () => JSON.stringify(reply.json) } as unknown as Response;
  });
  return calls;
}

const client = new OrbotoClient({ baseUrl: 'https://orboto.example.com', apiKey: 'orb_x' });
const text = (res: { content: unknown[] }) => (res.content[0] as { text: string }).text;

describe('orboto_admin_user_access', () => {
  it('is a destructive write a client confirms (it mails people and deletes their older unused access links), bounded to 100 accounts', () => {
    expect(adminUserAccessToolConfig.annotations).toEqual({ readOnlyHint: false, destructiveHint: true });
    expect(adminUserAccessToolConfig.inputSchema.users.safeParse(Array.from({ length: 101 }, () => 'a@b.c')).success).toBe(false);
  });

  it('resolves emails to ids, sends one bulk request and reports every account, an unknown email included', async () => {
    const calls = stub({
      'GET /admin/users': { json: { items: [{ id: ANNA, email: 'Anna@Example.org' }], nextCursor: null } },
      'POST /admin/users/access-email': { json: {
        results: [
          { userId: ANNA, email: 'anna@example.org', status: 'not_sent', linkIncluded: true, expiresAt: '2026-11-27T10:00:00.000Z', ssoProvider: null, resetUrl: 'https://o.example/auth/reset-password/t' },
          { userId: BOT, email: 'bot@example.org', status: 'skipped', reason: 'bot', linkIncluded: false, expiresAt: null, ssoProvider: null },
        ],
        sent: 0, notSent: 1, skipped: 1,
      } },
    });
    const res = await makeAdminUserAccessHandler(client)({ action: 'email', users: ['anna@example.org', BOT, 'ghost@example.org'] });
    expect(calls.filter((c) => c.method === 'POST')).toEqual([{ method: 'POST', path: '/admin/users/access-email', body: { userIds: [ANNA, BOT] } }]);
    expect(calls.filter((c) => c.method === 'GET').map((c) => c.path)).toEqual([
      '/admin/users?search=anna%40example.org&limit=25&hideGhosts=false',
      '/admin/users?search=ghost%40example.org&limit=25&hideGhosts=false',
    ]);
    expect(text(res)).toBe([
      'Access email: 0 sent, 1 not delivered, 2 skipped.',
      '- anna@example.org: NOT delivered; the link stays out of this transcript: a person gets one to hand over on Admin -> Users -> Security or with `orboto admin user reset-link <email>` in their own terminal',
      '- bot@example.org: skipped (bot)',
      '- ghost@example.org: skipped (no such account)',
    ].join('\n'));
    expect(res.structuredContent).toMatchObject({ notSent: 1, unknown: ['ghost@example.org'] });
    expect(JSON.stringify(res)).not.toContain('reset-password');
  });

  it('never prints an undelivered reset link into the transcript', async () => {
    stub({ [`POST /admin/users/${ANNA}/password-reset-link`]: { json: { sent: false, expiresAt: '2026-11-20T11:00:00.000Z', resetUrl: 'https://o.example/auth/reset-password/secret' } } });
    const res = await makeAdminUserAccessHandler(client)({ action: 'reset', users: [ANNA] });
    expect(text(res)).toMatch(/^No mail went out; the link stays out of this transcript/);
    expect(JSON.stringify(res)).not.toContain('secret');
  });

  it('names the provider when SSO enforcement minted no link, and never sends anyone to fetch one', async () => {
    stub({ 'POST /admin/users/access-email': { json: { results: [{ userId: ANNA, email: 'anna@example.org', status: 'not_sent', linkIncluded: false, expiresAt: null, ssoProvider: 'Okta' }], sent: 0, notSent: 1, skipped: 0 } } });
    const res = await makeAdminUserAccessHandler(client)({ action: 'email', users: [ANNA] });
    expect(text(res)).toBe('Access email: 0 sent, 1 not delivered, 0 skipped.\n- anna@example.org: NOT delivered; no link was minted, the account signs in with Okta');
  });

  it('says a person sends it when the server kept no link for this agent', async () => {
    stub({
      'POST /admin/users/access-email': { json: { results: [{ userId: ANNA, email: 'anna@example.org', status: 'skipped', reason: 'needs_person', linkIncluded: false, expiresAt: null, ssoProvider: null }], sent: 0, notSent: 0, skipped: 1 } },
      [`POST /admin/users/${ANNA}/password-reset-link`]: { status: 422, json: { error: 'x', errorKey: 'errors.users.account_link_needs_person' } },
    });
    const email = await makeAdminUserAccessHandler(client)({ action: 'email', users: [ANNA] });
    expect(text(email)).toBe('Access email: 0 sent, 0 not delivered, 1 skipped.\n- anna@example.org: NOT sent; no mail was delivered and the link goes only to a person, so none was kept: a person sends it from Admin -> Users, or set up outgoing mail');
    const reset = await makeAdminUserAccessHandler(client)({ action: 'reset', users: [ANNA] });
    expect(text(reset)).toMatch(/^No reset link: no mail was delivered and the link goes only to a person/);
    expect(reset.structuredContent).toEqual({ userId: ANNA, sent: false, kept: false });
  });

  it('names an account whose send failed on the server', async () => {
    stub({ 'POST /admin/users/access-email': { json: { results: [{ userId: ANNA, email: 'anna@example.org', status: 'not_sent', reason: 'error', linkIncluded: false, expiresAt: null, ssoProvider: null }], sent: 0, notSent: 1, skipped: 0 } } });
    const res = await makeAdminUserAccessHandler(client)({ action: 'email', users: [ANNA] });
    expect(text(res)).toBe('Access email: 0 sent, 1 not delivered, 0 skipped.\n- anna@example.org: NOT delivered, the send failed on the server');
  });

  it('mails one account the reset link and refuses a reset link for several', async () => {
    const calls = stub({ [`POST /admin/users/${ANNA}/password-reset-link`]: { json: { sent: true, expiresAt: '2026-11-20T11:00:00.000Z' } } });
    const res = await makeAdminUserAccessHandler(client)({ action: 'reset', users: [ANNA] });
    expect(calls).toEqual([{ method: 'POST', path: `/admin/users/${ANNA}/password-reset-link`, body: {} }]);
    expect(text(res)).toBe(`Reset link mailed to ${ANNA}, valid until 2026-11-20T11:00:00.000Z.`);
    await expect(makeAdminUserAccessHandler(client)({ action: 'reset', users: [ANNA, BOT] })).rejects.toThrow('reset takes exactly one account.');
  });

  it('turns a 403 into the server reason and the way through', async () => {
    stub({ 'POST /admin/users/access-email': { status: 403, json: { error: 'This API key sends reset links and access emails only when it lists the scope admin:users:write.', errorKey: 'errors.auth.account_link_key_scope_missing' } } });
    await expect(makeAdminUserAccessHandler(client)({ action: 'email', users: [ANNA] }))
      .rejects.toThrow(/^Refused: This API key sends reset links and access emails only when it lists the scope admin:users:write\. An OAuth connection never sends these/);
  });
});
