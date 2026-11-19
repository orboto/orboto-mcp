/**
 * ORB-2719 - `orboto_connector` handler tests: each action hits its route and
 * a missing field fails before any request.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OrbotoClient } from '../orboto-client.js';
import { connectorToolConfig, makeConnectorHandler } from './connector.js';

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
      ok: r.ok ?? true, status: r.status ?? 200, statusText: 'OK',
      json: async () => ('json' in r ? r.json : {}),
      text: async () => JSON.stringify('json' in r ? r.json : {}),
    } as unknown as Response;
  });
  return calls;
}

const client = new OrbotoClient({ baseUrl: 'https://orboto.example.com', apiKey: 'orb_x' });
const project = { id: '11111111-1111-4111-8111-111111111111', key: 'ALPHA', name: 'Alpha' };
const linkId = '22222222-2222-4222-8222-222222222222';
const link = {
  id: linkId, projectId: project.id, provider: 'jira', siteUrl: 'https://acme.atlassian.net', externalProjectKey: 'ALPHA', scopeFilter: 'labels = agent',
  authKind: 'api_token', state: 'live', enabled: true, webhookMode: 'admin', lastWebhookAt: null, lastPollAt: null, lastError: null, consecutiveFailures: 0,
};

describe('orboto_connector', () => {
  it('declares a short title and explicit annotations', () => {
    expect(connectorToolConfig.title.length).toBeLessThanOrEqual(64);
    expect(connectorToolConfig.annotations).toEqual({ readOnlyHint: false, destructiveHint: false, idempotentHint: true });
  });

  it('lists the links of a project', async () => {
    stub([{ json: project }, { json: [link] }]);
    const out = await makeConnectorHandler(client)({ action: 'list', projectKey: 'ALPHA' });
    expect((out.content[0] as { text: string }).text).toContain('jira https://acme.atlassian.net ALPHA state=live auth=api_token webhooks=admin scope=labels = agent');
  });

  it('names the source issue of a ticket and the fields Jira owns', async () => {
    const calls = stub([
      { json: project }, { json: project }, { json: { id: '44444444-4444-4444-8444-444444444444', ticketKey: 'ALPHA-2', projectId: project.id } },
      { json: { sourceLink: { provider: 'jira', externalKey: 'ALPHA-2', externalUrl: 'https://acme.atlassian.net/browse/ALPHA-2', state: 'linked', sourceOwnedFields: ['title', 'priority'] } } },
    ]);
    const out = await makeConnectorHandler(client)({ action: 'source_link', projectKey: 'ALPHA', ticketKey: 'ALPHA-2' });
    expect(calls.at(-1)!.url).toContain(`/projects/${project.id}/tickets/44444444-4444-4444-8444-444444444444/source-link`);
    expect((out.content[0] as { text: string }).text).toBe('ALPHA-2 mirrors jira ALPHA-2 (linked) https://acme.atlassian.net/browse/ALPHA-2; owned there: title, priority');
  });

  it('reads the health and reconciles through the link routes', async () => {
    const calls = stub([
      { json: project }, { json: { healthy: false, reasons: ['dead_deliveries'], state: 'live', linkedIssues: 2, outbox: { pending: 0, failed: 0, dead: 1 } } },
      { json: project }, { json: { reconciled: 3, imported: 1, unlinked: 0, cursor: null } },
    ]);
    const handler = makeConnectorHandler(client);
    expect((await handler({ action: 'health', projectKey: 'ALPHA', linkId })).content[0]).toMatchObject({ text: expect.stringContaining('needs attention: dead_deliveries') });
    expect((await handler({ action: 'sync', projectKey: 'ALPHA', linkId })).structuredContent).toMatchObject({ imported: 1 });
    expect(calls.map((c) => `${c.method} ${new URL(c.url).pathname}`).filter((c) => c.includes('/connectors'))).toEqual([
      `GET /projects/${project.id}/connectors/${linkId}/health`,
      `POST /projects/${project.id}/connectors/${linkId}/sync`,
    ]);
  });

  it('names a Jira Data Center instance the connector cannot reach (ORB-3123)', async () => {
    const since = '2026-11-19T08:00:00.000Z';
    const dc = { ...link, provider: 'jira_dc', siteUrl: 'https://jira.example.test/jira', webhookMode: 'poll', unreachableSince: since };
    stub([
      { json: project }, { json: [dc] },
      { json: project }, { json: { healthy: false, reasons: ['site_unreachable', 'failing'], state: 'live', siteUrl: dc.siteUrl, unreachableSince: since, linkedIssues: 4, outbox: { pending: 2, failed: 0, dead: 0 } } },
    ]);
    const handler = makeConnectorHandler(client);
    expect((await handler({ action: 'list', projectKey: 'ALPHA' })).content[0]).toMatchObject({ text: expect.stringContaining(`jira_dc https://jira.example.test/jira ALPHA state=live unreachable since ${since} auth=api_token webhooks=poll`) });
    expect((await handler({ action: 'health', projectKey: 'ALPHA', linkId })).content[0]).toMatchObject({ text: `needs attention: site_unreachable, failing - https://jira.example.test/jira unreachable since ${since} - state=live mirrored=4 outbox pending=2 failed=0 dead=0` });
  });

  it('lists an OpenProject link whose webhook an administrator enters and names it unconfirmed until it delivers (ORB-3122)', async () => {
    const op = { ...link, provider: 'openproject', siteUrl: 'https://openproject.example.test/op', externalProjectKey: 'payments', webhookMode: 'manual_signed', authKind: 'oauth' };
    stub([
      { json: project }, { json: [op] },
      { json: project }, { json: { healthy: false, reasons: ['webhook_unconfirmed'], state: 'live', siteUrl: op.siteUrl, unreachableSince: null, linkedIssues: 2, outbox: { pending: 0, failed: 0, dead: 0 } } },
    ]);
    const handler = makeConnectorHandler(client);
    expect((await handler({ action: 'list', projectKey: 'ALPHA' })).content[0]).toMatchObject({ text: expect.stringContaining('openproject https://openproject.example.test/op payments state=live auth=oauth webhooks=manual_signed') });
    expect((await handler({ action: 'health', projectKey: 'ALPHA', linkId })).content[0]).toMatchObject({ text: 'needs attention: webhook_unconfirmed - state=live mirrored=2 outbox pending=0 failed=0 dead=0' });
  });

  it('fails before any connector request when a field is missing', async () => {
    const calls = stub([{ json: project }, { json: project }]);
    await expect(makeConnectorHandler(client)({ action: 'source_link', projectKey: 'ALPHA' })).rejects.toThrow('source_link needs ticketKey');
    await expect(makeConnectorHandler(client)({ action: 'sync', projectKey: 'ALPHA' })).rejects.toThrow('sync needs linkId');
    expect(calls.filter((c) => c.url.includes('/connectors') || c.url.includes('/source-link'))).toHaveLength(0);
  });
});
