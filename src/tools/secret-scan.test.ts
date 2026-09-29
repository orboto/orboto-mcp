/** ORB-2229, ORB-2261 - orboto_secret_scan prints each hit masked and the finding id of every move offer. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OrbotoClient } from '../orboto-client.js';
import { makeSecretScanHandler } from './secret-scan.js';

afterEach(() => { vi.restoreAllMocks(); });

const client = new OrbotoClient({ baseUrl: 'https://orboto.example.org', apiKey: 'orb_x' });

describe('orboto_secret_scan', () => {
  it('lists the move offers with their finding ids and never a value', async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      calls.push({ url: url.toString(), body: init?.body ? JSON.parse(init.body as string) : undefined });
      return {
        ok: true, status: 200, statusText: 'OK', text: async () => '',
        json: async () => ({
          scannedAt: '2026-09-29T10:00:00.000Z', scanned: { doc: 1 }, redacted: 0, nextCursor: null, truncated: false,
          hits: [{
            entity: 'doc', id: 'd1', label: 'ACME-D38', field: 'content', projectKey: 'ACME', spaceVisibility: 'workspace', webUrl: null,
            findings: [{ class: 'labelled_value', line: 3, column: 11, preview: 'Hk***', length: 12 }], redacted: false,
            moves: [{ findingId: 'WyJkb2MiXQ', kind: 'login', findingIndexes: [0] }],
          }],
        }),
      } as unknown as Response;
    });
    const res = await makeSecretScanHandler(client)({});
    expect(calls[0].url).toContain('/admin/content/secret-scan');
    const text = (res.content[0] as { text: string }).text;
    expect(text).toContain('move as login: findingId WyJkb2MiXQ');
    expect(res.structuredContent).toMatchObject({ hits: [{ moves: [{ findingId: 'WyJkb2MiXQ', kind: 'login' }] }] });
  });
});
