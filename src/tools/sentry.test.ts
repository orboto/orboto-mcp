/**
 * ORB-2123 - `orboto_sentry` handler tests: every action hits the right
 * route, secrets never come back in the text, and a missing field fails
 * before any write.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OrbotoClient } from '../orboto-client.js';
import { makeSentryHandler, sentryToolConfig } from './sentry.js';

beforeEach(() => { vi.restoreAllMocks(); });
afterEach(() => { vi.restoreAllMocks(); });

function stub(responses: Array<{ ok?: boolean; status?: number; json?: unknown }>) {
  const calls: Array<{ url: string; method: string; body?: unknown }> = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    const u = url.toString();
    const m = init?.method ?? 'GET';
    const b = init?.body ? JSON.parse(init.body as string) : undefined;
    calls.push({ url: u, method: m, body: b });
    const r = responses.shift();
    if (!r) throw new Error(`unexpected extra fetch ${m} ${u}`);
    return {
      ok: r.ok ?? true,
      status: r.status ?? 200,
      statusText: r.ok === false ? 'Error' : 'OK',
      json: async () => ('json' in r ? r.json : {}),
      text: async () => JSON.stringify('json' in r ? r.json : {}),
    } as unknown as Response;
  });
  return calls;
}

const client = new OrbotoClient({ baseUrl: 'https://orboto.example.com', apiKey: 'orb_x' });
const project = { id: '11111111-1111-4111-8111-111111111111', key: 'TEN', name: '10monkeys' };
const connectionId = '22222222-2222-4222-8222-222222222222';
const connection = {
  id: connectionId, orgSlug: 'edyoutec', projectSlug: '10monkeys-next', enabled: true, triageMode: 'comment', hasAuthToken: false,
  webhookUrl: 'https://orboto.example.com/inbound/sentry/' + connectionId, lastWebhookAt: null, lastSignatureOk: null, lastError: null, webhookCount: 0,
  triageLaneId: null, dailyTriageLimit: null, escalationUserId: null,
};

describe('orboto_sentry', () => {
  it('declares a short title and explicit annotations', () => {
    expect(sentryToolConfig.title.length).toBeLessThanOrEqual(64);
    expect(sentryToolConfig.annotations).toEqual({ readOnlyHint: false, destructiveHint: true, idempotentHint: false });
  });

  it('lists connections with their webhook URL and health', async () => {
    stub([{ json: project }, { json: [connection] }]);
    const out = await makeSentryHandler(client)({ action: 'list', projectKey: 'TEN' });
    const text = (out.content[0] as { text: string }).text;
    expect(text).toContain('edyoutec/10monkeys-next mode=comment enabled token=no');
    expect(text).toContain(connection.webhookUrl);
    expect(out.structuredContent).toEqual({ connections: [connection] });
  });

  it('connects with the client secret in the body and never in the text', async () => {
    const calls = stub([{ json: project }, { json: { ...connection, triageMode: 'fix_branch', webhookUrlWarning: { code: 'webhook_url_from_request', message: 'set API_PUBLIC_URL' } } }]);
    const out = await makeSentryHandler(client)({ action: 'connect', projectKey: 'TEN', orgSlug: 'edyoutec', projectSlug: '10monkeys-next', clientSecret: 'sec_value_123', triageMode: 'fix_branch' });
    expect(calls[1]).toMatchObject({ method: 'POST', url: expect.stringContaining(`/projects/${project.id}/sentry-connections`), body: { orgSlug: 'edyoutec', projectSlug: '10monkeys-next', clientSecret: 'sec_value_123', triageMode: 'fix_branch' } });
    const text = (out.content[0] as { text: string }).text;
    expect(text).toContain('Connected edyoutec/10monkeys-next to TEN');
    expect(text).toContain('Warning: set API_PUBLIC_URL');
    expect(text).not.toContain('sec_value_123');
    expect(JSON.stringify(out.structuredContent)).not.toContain('sec_value_123');
  });

  it('refuses a connect without the secret before any write', async () => {
    const calls = stub([{ json: project }]);
    await expect(makeSentryHandler(client)({ action: 'connect', projectKey: 'TEN', orgSlug: 'edyoutec', projectSlug: 'p' })).rejects.toThrow('connect needs clientSecret.');
    expect(calls).toHaveLength(1);
  });

  it('routes health, update, rotate_secret, disconnect and triage_lane to their endpoints', async () => {
    const calls = stub([
      { json: project }, { json: { healthy: true, lastWebhookAt: '2026-09-14T08:00:00Z', lastError: null, linkedIssues: 3, openLinkedIssues: 1, webhookCount: 9 } },
      { json: project }, { json: { ...connection, triageMode: 'fix_branch' } },
      { json: project }, { json: connection },
      { json: project }, { json: { deleted: true } },
      { json: project }, { json: { connection, lane: { id: 'l1', name: 'sentry-triage-1', assignmentVersion: 3 } } },
      { json: project }, { json: { connection, lane: null } },
    ]);
    const h = makeSentryHandler(client);
    expect((await h({ action: 'health', projectKey: 'TEN', connectionId })).content[0]).toMatchObject({ text: expect.stringContaining('healthy - deliveries=9') });
    expect((await h({ action: 'update', projectKey: 'TEN', connectionId, triageMode: 'fix_branch' })).content[0]).toMatchObject({ text: expect.stringContaining('Triage mode is now fix_branch') });
    expect((await h({ action: 'rotate_secret', projectKey: 'TEN', connectionId, clientSecret: 'new_secret_value' })).content[0]).toMatchObject({ text: expect.not.stringContaining('new_secret_value') });
    expect((await h({ action: 'disconnect', projectKey: 'TEN', connectionId })).structuredContent).toEqual({ deleted: true, connectionId });
    expect((await h({ action: 'triage_lane', projectKey: 'TEN', connectionId, laneId: 'l1' })).content[0]).toMatchObject({ text: expect.stringContaining('Lane sentry-triage-1 bound (assignment v3)') });
    expect((await h({ action: 'triage_lane', projectKey: 'TEN', connectionId })).content[0]).toMatchObject({ text: expect.stringContaining('unbound') });
    expect(calls.map((c) => `${c.method} ${c.url.replace('https://orboto.example.com', '')}`)).toEqual([
      'GET /projects/by-key/TEN', `GET /projects/${project.id}/sentry-connections/${connectionId}/health`,
      'GET /projects/by-key/TEN', `PATCH /projects/${project.id}/sentry-connections/${connectionId}`,
      'GET /projects/by-key/TEN', `POST /projects/${project.id}/sentry-connections/${connectionId}/rotate-secret`,
      'GET /projects/by-key/TEN', `DELETE /projects/${project.id}/sentry-connections/${connectionId}`,
      'GET /projects/by-key/TEN', `PUT /projects/${project.id}/sentry-connections/${connectionId}/triage-lane`,
      'GET /projects/by-key/TEN', `PUT /projects/${project.id}/sentry-connections/${connectionId}/triage-lane`,
    ]);
    expect(calls[9].body).toEqual({ laneId: 'l1' });
    expect(calls[11].body).toEqual({ laneId: null });
  });

  it('records a verdict on the ticket resolved by key and reports the hand-off', async () => {
    const calls = stub([
      { json: project },
      { json: project },
      { json: { id: '33333333-3333-4333-8333-333333333333', ticketKey: 'TEN-7', title: 'x' } },
      { json: { ticketKey: 'TEN-7', verdict: 'new', mode: 'fix_branch', closed: false, escalated: false, branchName: 'sentry/ten-7-fix', workSessionId: 'ws1', nextStep: 'implement_then_finish', priority: 'high' } },
    ]);
    const out = await makeSentryHandler(client)({ action: 'verdict', projectKey: 'TEN', connectionId, ticketKey: 'TEN-7', verdict: 'new', summary: 'Unguarded read of session.cart.' });
    expect(calls[3]).toMatchObject({ method: 'POST', url: expect.stringContaining(`/sentry-connections/${connectionId}/triage/33333333-3333-4333-8333-333333333333/verdict`) });
    expect(calls[3].body).toMatchObject({ verdict: 'new', summary: 'Unguarded read of session.cart.' });
    expect(typeof (calls[3].body as { agentSessionToken: string }).agentSessionToken).toBe('string');
    expect((out.content[0] as { text: string }).text).toBe('TEN-7: new (fix_branch) priority=high branch=sentry/ten-7-fix session=ws1 next=implement_then_finish');
  });
});
