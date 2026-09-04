/**
 * ORB-244 Phase C Group 4 - admin-only tool tests.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OrbotoClient } from '../orboto-client.js';
import {
  makeListUsersHandler, makeGetAuditLogHandler, makeTriggerBackupHandler,
} from './admin-writes.js';

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
      statusText: 'OK',
      json: async () => ('json' in r ? r.json : {}),
      text: async () => '',
    } as unknown as Response;
  });
  return calls;
}

const client = new OrbotoClient({ baseUrl: 'https://orboto.example.com', apiKey: 'orb_x' });

describe('orboto_list_users', () => {
  it('passes search + limit, surfaces user tags in text output', async () => {
    const calls = stub([{
      json: {
        items: [
          { id: 'u1', email: 'ada@acme', fullName: 'Ada', isActive: true, isExternal: false, isBot: false, createdAt: 'now' },
          { id: 'u2', email: 'bot@acme', fullName: 'CI Bot', isActive: true, isExternal: false, isBot: true, createdAt: 'now' },
          { id: 'u3', email: 'inactive@acme', fullName: 'Old', isActive: false, isExternal: false, isBot: false, createdAt: 'now' },
        ],
        nextCursor: null,
      },
    }]);
    const res = await makeListUsersHandler(client)({ search: 'acme', limit: 10 });
    expect(calls[0].url).toContain('search=acme');
    expect(calls[0].url).toContain('limit=10');
    const text = (res.content[0] as { text: string }).text;
    expect(text).toContain('[bot]');
    expect(text).toContain('[disabled]');
  });

  it('rewrites a 403 into a "super-admin required" message', async () => {
    stub([{ ok: false, status: 403, json: { error: 'Forbidden' } }]);
    await expect(
      makeListUsersHandler(client)({})
    ).rejects.toThrow(/super-admin permissions/);
  });
});

describe('orboto_get_audit_log', () => {
  it('plain entityType filter just queries with entityType', async () => {
    const calls = stub([{ json: { items: [], nextCursor: null } }]);
    await makeGetAuditLogHandler(client)({ entityType: 'user', limit: 25 });
    expect(calls[0].url).toContain('/admin/audit-log?');
    expect(calls[0].url).toContain('entityType=user');
    expect(calls[0].url).toContain('limit=25');
  });

  it('actorEmail resolves through admin-users to actorId', async () => {
    const calls = stub([
      { json: { items: [{ id: 'u1', email: 'ada@acme', fullName: 'Ada', isActive: true, isExternal: false, isBot: false, createdAt: 'now' }], nextCursor: null } },
      { json: { items: [], nextCursor: null } },
    ]);
    await makeGetAuditLogHandler(client)({ actorEmail: 'ada@acme' });
    // Call 0 = users-search lookup, Call 1 = audit-log with actorId=u1
    expect(calls[0].url).toContain('/admin/users');
    expect(calls[1].url).toContain('actorId=u1');
  });

  it('throws when actorEmail does not match a workspace user', async () => {
    stub([
      { json: { items: [], nextCursor: null } },
    ]);
    await expect(
      makeGetAuditLogHandler(client)({ actorEmail: 'ghost@acme' })
    ).rejects.toThrow(/No workspace user with email/);
  });

  it('renders entries with actor + action + entity hint in text', async () => {
    stub([{
      json: {
        items: [
          { id: 'a1', actorId: 'u1', actorEmail: 'ada@acme', actorName: 'Ada', action: 'user.deactivated', entityType: 'user', entityId: 'u9-aaaaaaaa-...', details: {}, createdAt: '2026-04-25T07:00:00Z' },
        ],
        nextCursor: null,
      },
    }]);
    const res = await makeGetAuditLogHandler(client)({});
    const text = (res.content[0] as { text: string }).text;
    expect(text).toContain('Ada → user.deactivated user:u9-aaaaa');
  });
});

describe('orboto_trigger_backup', () => {
  it('resolves jobName → jobId, then POSTs the run', async () => {
    const calls = stub([
      { json: [{ id: 'j1', name: 'nightly', scope: 'full', schedule: '0 3 * * *', isActive: true }] },
      { json: { id: 'r1', jobId: 'j1', startedAt: 'now', finishedAt: null, status: 'running', storagePath: null, error: null } },
    ]);
    await makeTriggerBackupHandler(client)({ jobName: 'nightly' });
    expect(calls[1].method).toBe('POST');
    expect(calls[1].url).toContain('/admin/backup/jobs/j1/run');
  });

  it('throws when jobName does not match', async () => {
    stub([
      { json: [{ id: 'j1', name: 'nightly', scope: 'full', schedule: null, isActive: true }] },
    ]);
    await expect(
      makeTriggerBackupHandler(client)({ jobName: 'weekly' })
    ).rejects.toThrow(/"weekly"/);
  });

  it('throws on a disabled job (don\'t silently no-op)', async () => {
    stub([
      { json: [{ id: 'j1', name: 'paused', scope: 'full', schedule: null, isActive: false }] },
    ]);
    await expect(
      makeTriggerBackupHandler(client)({ jobName: 'paused' })
    ).rejects.toThrow(/currently disabled/);
  });

  it('rewrites a 403 from the API into a permission-clarifying error', async () => {
    stub([
      { ok: false, status: 403, json: { error: 'Forbidden' } },
    ]);
    await expect(
      makeTriggerBackupHandler(client)({ jobName: 'nightly' })
    ).rejects.toThrow(/super-admin/);
  });
});
