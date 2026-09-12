/**
 * ORB-2114 - `orboto_git_rotate_token` handler tests.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OrbotoClient } from '../orboto-client.js';
import { gitRotateTokenToolConfig, makeGitRotateTokenHandler } from './git-rotate-token.js';

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
const project = { id: '11111111-1111-4111-8111-111111111111', key: 'ORB', name: 'orboto' };
const connectionId = '22222222-2222-4222-8222-222222222222';
const health = { connectionId, name: 'Forgejo - orboto/orboto', healthy: true, tokenState: 'ok', unhealthySince: null, reason: null };

describe('orboto_git_rotate_token', () => {
  it('posts the new access token to the rotate route and returns the health row', async () => {
    const calls = stub([{ json: project }, { json: { rotated: true, health } }]);
    const out = await makeGitRotateTokenHandler(client)({ projectKey: 'ORB', connectionId, accessToken: 'tok_new' });
    expect(calls[0]).toMatchObject({ method: 'GET', url: expect.stringContaining('/projects/by-key/ORB') });
    expect(calls[1]).toMatchObject({
      method: 'POST',
      url: expect.stringContaining(`/projects/${project.id}/git-connections/${connectionId}/rotate-token`),
      body: { accessToken: 'tok_new' },
    });
    expect(out.structuredContent).toEqual({ connectionId, name: health.name, healthy: true, tokenState: 'ok', reason: null });
    const text = (out.content[0] as { text: string }).text;
    expect(text).toContain('Rotated the credential');
    expect(text).not.toContain('tok_new');
  });

  it('passes privateKey and reinstallWebhook through and reports the reinstalled hook', async () => {
    const calls = stub([
      { json: project },
      { json: { rotated: true, health, webhookUrl: 'https://orboto.example.com/git/webhook/x', webhookAutoInstalled: true, webhookInstallError: null } },
    ]);
    const out = await makeGitRotateTokenHandler(client)({ projectKey: 'ORB', connectionId, privateKey: '-----BEGIN KEY-----', reinstallWebhook: true });
    expect(calls[1].body).toEqual({ privateKey: '-----BEGIN KEY-----', reinstallWebhook: true });
    expect((out.content[0] as { text: string }).text).toContain('Webhook reinstalled on https://orboto.example.com/git/webhook/x');
    expect(out.structuredContent).toMatchObject({ webhookUrl: 'https://orboto.example.com/git/webhook/x' });
  });

  it('reports a failed webhook install with its error', async () => {
    stub([
      { json: project },
      { json: { rotated: true, health: { ...health, healthy: false, tokenState: 'unknown', reason: 'outbound_unreachable' }, webhookUrl: 'https://orboto.example.com/git/webhook/x', webhookAutoInstalled: false, webhookInstallError: 'Gitea: 403' } },
    ]);
    const out = await makeGitRotateTokenHandler(client)({ projectKey: 'ORB', connectionId, accessToken: 'tok' });
    const text = (out.content[0] as { text: string }).text;
    expect(text).toContain('Webhook install failed for https://orboto.example.com/git/webhook/x - Gitea: 403');
    expect(text).toContain('(outbound_unreachable)');
  });

  it('refuses when neither or both credentials are given, before any request', async () => {
    const calls = stub([]);
    await expect(makeGitRotateTokenHandler(client)({ projectKey: 'ORB', connectionId })).rejects.toThrow('exactly one');
    await expect(makeGitRotateTokenHandler(client)({ projectKey: 'ORB', connectionId, accessToken: 'a', privateKey: 'b' })).rejects.toThrow('exactly one');
    expect(calls).toHaveLength(0);
  });

  it('surfaces a rejected token as the API error', async () => {
    stub([{ json: project }, { ok: false, status: 422, json: { error: 'errors.git.token_rejected' } }]);
    await expect(makeGitRotateTokenHandler(client)({ projectKey: 'ORB', connectionId, accessToken: 'bad' })).rejects.toThrow();
  });

  it('names an unknown project key', async () => {
    stub([{ ok: false, status: 404, json: { error: 'errors.projects.not_found' } }]);
    await expect(makeGitRotateTokenHandler(client)({ projectKey: 'NOPE', connectionId, accessToken: 'tok' })).rejects.toThrow('Project "NOPE" not found');
  });

  it('declares a write tool with a title and an output schema', () => {
    expect(gitRotateTokenToolConfig.title).toMatch(/rotate/i);
    expect(gitRotateTokenToolConfig.annotations.readOnlyHint).toBe(false);
    expect(Object.keys(gitRotateTokenToolConfig.outputSchema)).toEqual(expect.arrayContaining(['connectionId', 'tokenState']));
  });
});
