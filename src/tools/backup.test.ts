/**
 * ORB-1301 — backup tool tests.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OrbotoClient } from '../orboto-client.js';
import {
  makeCreateFullBackupHandler,
  makeListBackupsHandler,
  makeDownloadBackupHandler,
} from './backup.js';

beforeEach(() => { vi.restoreAllMocks(); });
afterEach(() => { vi.restoreAllMocks(); });

const client = new OrbotoClient({ baseUrl: 'https://orboto.example.com', apiKey: 'orb_x' });

function stubBinary(bytes: Uint8Array, contentType = 'application/zip') {
  const calls: Array<{ url: string; method: string }> = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    calls.push({ url: url.toString(), method: init?.method ?? 'GET' });
    return {
      ok: true, status: 200, statusText: 'OK',
      headers: new Headers({ 'content-type': contentType }),
      text: async () => '',
      arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
      json: async () => { throw new Error('not json'); },
    } as unknown as Response;
  });
  return calls;
}

function stubJson(body: unknown) {
  const calls: Array<{ url: string; method: string }> = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    calls.push({ url: url.toString(), method: init?.method ?? 'GET' });
    return {
      ok: true, status: 200, statusText: 'OK',
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => body,
      text: async () => JSON.stringify(body),
    } as unknown as Response;
  });
  return calls;
}

describe('orboto_create_full_backup (ORB-1301 / async since ORB-1717)', () => {
  it('enqueues, polls the run to success, then downloads the stored ZIP', async () => {
    vi.useFakeTimers();
    const zip = new Uint8Array([0x50, 0x4b, 0x03, 0x04]); // PK\x03\x04
    const calls: Array<{ url: string; method: string }> = [];
    let polls = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      const u = url.toString();
      calls.push({ url: u, method: init?.method ?? 'GET' });
      if (u.endsWith('/admin/backup/full')) {
        return { ok: true, status: 202, statusText: 'Accepted', headers: new Headers({ 'content-type': 'application/json' }), json: async () => ({ runId: 'run-1' }), text: async () => '' } as unknown as Response;
      }
      if (u.includes('/admin/backup/runs/run-1/download')) {
        return { ok: true, status: 200, statusText: 'OK', headers: new Headers({ 'content-type': 'application/zip' }), arrayBuffer: async () => zip.buffer.slice(0), text: async () => '' } as unknown as Response;
      }
      // poll: running twice, then success
      polls += 1;
      return { ok: true, status: 200, statusText: 'OK', headers: new Headers({ 'content-type': 'application/json' }), json: async () => ({ status: polls < 3 ? 'running' : 'success', errorMessage: null }), text: async () => '' } as unknown as Response;
    });
    try {
      const pending = makeCreateFullBackupHandler(client)();
      await vi.advanceTimersByTimeAsync(15_000);
      const res = await pending;
      expect(calls[0].method).toBe('POST');
      expect(calls[0].url).toContain('/admin/backup/full');
      const resource = res.content.find((c) => c.type === 'resource') as { resource: { blob: string; mimeType: string } };
      expect(resource.resource.mimeType).toBe('application/zip');
      expect(Buffer.from(resource.resource.blob, 'base64')).toEqual(Buffer.from(zip));
      expect((res.structuredContent as { runId: string }).runId).toBe('run-1');
    } finally {
      vi.useRealTimers();
    }
  });

  it('a failed run surfaces the error instead of a partial ZIP', async () => {
    vi.useFakeTimers();
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, _init) => {
      const u = url.toString();
      if (u.endsWith('/admin/backup/full')) {
        return { ok: true, status: 202, statusText: 'Accepted', headers: new Headers({ 'content-type': 'application/json' }), json: async () => ({ runId: 'run-2' }), text: async () => '' } as unknown as Response;
      }
      return { ok: true, status: 200, statusText: 'OK', headers: new Headers({ 'content-type': 'application/json' }), json: async () => ({ status: 'failed', errorMessage: 'disk full' }), text: async () => '' } as unknown as Response;
    });
    try {
      const pending = makeCreateFullBackupHandler(client)();
      const assertion = expect(pending).rejects.toThrow('disk full');
      await vi.advanceTimersByTimeAsync(6_000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('orboto_list_backups (ORB-1301)', () => {
  it('GETs /admin/backup/runs and returns the runs', async () => {
    const calls = stubJson({ items: [{ id: 'r1', status: 'success', fileSizeBytes: 1048576, completedAt: 'now' }] });
    const res = await makeListBackupsHandler(client)();
    expect(calls[0].url).toContain('/admin/backup/runs');
    expect((res.structuredContent as { runs: unknown[] }).runs).toHaveLength(1);
  });
});

describe('orboto_download_backup (ORB-1301)', () => {
  it('GETs the run download and returns the ZIP as a resource', async () => {
    const zip = new Uint8Array([0x50, 0x4b]);
    const calls = stubBinary(zip);
    const res = await makeDownloadBackupHandler(client)({ runId: 'r1' });
    expect(calls[0].method).toBe('GET');
    expect(calls[0].url).toContain('/admin/backup/runs/r1/download');
    expect((res.structuredContent as { runId: string }).runId).toBe('r1');
  });
});
