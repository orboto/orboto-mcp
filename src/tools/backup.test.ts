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

describe('orboto_create_full_backup (ORB-1301)', () => {
  it('POSTs /admin/backup/full and returns the ZIP as a base64 resource', async () => {
    const zip = new Uint8Array([0x50, 0x4b, 0x03, 0x04]); // PK\x03\x04
    const calls = stubBinary(zip);
    const res = await makeCreateFullBackupHandler(client)();
    expect(calls[0].method).toBe('POST');
    expect(calls[0].url).toContain('/admin/backup/full');
    const resource = res.content.find((c) => c.type === 'resource') as { resource: { blob: string; mimeType: string } };
    expect(resource.resource.mimeType).toBe('application/zip');
    expect(Buffer.from(resource.resource.blob, 'base64')).toEqual(Buffer.from(zip));
    expect((res.structuredContent as { sizeBytes: number }).sizeBytes).toBe(4);
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
