/** ORB-3090 - orboto_secret_exposures lists the incidents masked, forwards the filters, and its local type stays the shared schema's shape. */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OrbotoClient } from '../orboto-client.js';
import { makeSecretExposuresHandler, secretExposuresToolConfig, type SecretExposure } from './secret-exposures.js';

afterEach(() => { vi.restoreAllMocks(); });

const client = new OrbotoClient({ baseUrl: 'https://orboto.example.org', apiKey: 'orb_x' });

const row: SecretExposure = {
  id: '11111111-1111-4111-8111-111111111111', reportId: '22222222-2222-4222-8222-222222222222', class: 'github_token', source: 'pattern',
  preview: 'gh***', length: 40, sha256: 'a'.repeat(64), toolName: 'Bash', stage: 'command_output', harness: 'claude', harnessSessionId: 'cc-1',
  hostLabel: 'build-box', reporterId: null, reporterName: 'Bot', agentSessionId: null, projectId: null, projectKey: 'ACME',
  credentialId: null, credentialKey: 'deploy-token', state: 'open', resolvedAt: null, resolvedBy: null, resolutionNote: null,
  rotatedCredentialId: null, createdAt: '2026-11-15T08:00:00.000Z',
};

describe('orboto_secret_exposures', () => {
  it('forwards the filters and prints each incident masked with its credential', async () => {
    const urls: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      urls.push(url.toString());
      return { ok: true, status: 200, statusText: 'OK', text: async () => '', json: async () => ({ items: [row], nextCursor: 'next-1' }) } as unknown as Response;
    });
    const res = await makeSecretExposuresHandler(client)({ state: 'open', session: 'cc-1', limit: 10 });
    expect(urls[0]).toContain('/admin/secret-exposures?state=open&session=cc-1&limit=10');
    const text = (res.content[0] as { text: string }).text;
    expect(text).toContain('github_token (gh***, 40 chars) in Bash output of Bot [ACME, build-box, claude] - matches deploy-token, due for rotation - open');
    expect(text).toContain('More: cursor next-1');
    expect(secretExposuresToolConfig.annotations.readOnlyHint).toBe(true);
  });

  it('mirrors every field of the shared SecretExposureSchema', () => {
    const shared = readFileSync(path.resolve(__dirname, '../../../../packages/shared-schema/src/secret-exposures.ts'), 'utf8');
    const block = shared.slice(shared.indexOf('export const SecretExposureSchema'), shared.indexOf('export const SecretExposureListQuerySchema'));
    const fields = [...block.matchAll(/^\s{2}(\w+):/gm)].map((m) => m[1]).sort();
    expect(fields).toEqual(Object.keys(row).sort());
  });
});
