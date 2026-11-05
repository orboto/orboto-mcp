/** ORB-2834 - `orboto_git_probe` handler tests. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OrbotoClient } from '../orboto-client.js';
import { gitProbeToolConfig, makeGitProbeHandler } from './git-probe.js';

beforeEach(() => { vi.restoreAllMocks(); });
afterEach(() => { vi.restoreAllMocks(); });

function stub(responses: Array<{ ok?: boolean; status?: number; json?: unknown }>) {
  const calls: Array<{ url: string; method: string; body?: unknown }> = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    calls.push({ url: url.toString(), method: init?.method ?? 'GET', body: init?.body ? JSON.parse(init.body as string) : undefined });
    const r = responses.shift();
    if (!r) throw new Error(`unexpected extra fetch ${init?.method ?? 'GET'} ${url.toString()}`);
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
const project = { id: '11111111-1111-4111-8111-111111111111', key: 'ORB', name: 'orboto' };
const connectionId = '22222222-2222-4222-8222-222222222222';
const health = {
  connectionId, name: 'Forgejo - acme/app', healthy: true, reason: null, outboundReachable: true, inboundDelivering: null,
  tokenState: 'ok', deliveryError: null, lastProbeAt: '2026-11-05T10:00:00.000Z', probePending: false, nextProbeAt: '2026-11-05T10:10:00.000Z',
};

describe('orboto_git_probe', () => {
  it('posts to the probe route of the project and answers the fresh health', async () => {
    const calls = stub([{ json: project }, { json: { health, durationMs: 412, timedOut: false } }]);
    const out = await makeGitProbeHandler(client)({ projectKey: 'ORB', connectionId });
    expect(calls[1]).toMatchObject({ method: 'POST', url: expect.stringContaining(`/projects/${project.id}/git-connections/${connectionId}/probe`) });
    expect(out.structuredContent).toEqual({ health, durationMs: 412, timedOut: false });
    const text = (out.content[0] as { text: string }).text;
    expect(text).toContain('Probed "Forgejo - acme/app"');
    expect(text).toContain('Outbound ok, inbound unknown, token ok; healthy: true.');
  });

  it('says when the probe ran into its time bound and names the provider error', async () => {
    stub([{ json: project }, { json: { health: { ...health, healthy: false, reason: 'outbound_unreachable', outboundReachable: false, deliveryError: 'probe timed out after 20 s' }, durationMs: 20004, timedOut: true } }]);
    const text = ((await makeGitProbeHandler(client)({ projectKey: 'ORB', connectionId })).content[0] as { text: string }).text;
    expect(text).toContain('ran into the time bound');
    expect(text).toContain('(outbound_unreachable)');
    expect(text).toContain('Provider error: probe timed out after 20 s');
  });

  it('surfaces the refusal of the route', async () => {
    stub([{ json: project }, { ok: false, status: 422, json: { error: 'SSH-poll connections have no probe', errorKey: 'errors.git.probe_unsupported' } }]);
    await expect(makeGitProbeHandler(client)({ projectKey: 'ORB', connectionId })).rejects.toThrow();
  });

  it('is a non-destructive, idempotent write', () => {
    expect(gitProbeToolConfig.annotations).toEqual({ readOnlyHint: false, destructiveHint: false, idempotentHint: true });
  });
});
