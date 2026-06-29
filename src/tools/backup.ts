/**
 * ORB-1301 — backup MCP tools. Four-way parity with the skill/UI, which can
 * create an on-demand full backup and download the ZIP. The MCP previously only
 * had orboto_trigger_backup (run a pre-configured named job).
 *
 * Binary archives are returned as MCP `resource` content attachments (base64
 * blob + mimeType + uri), exactly like orboto_export_doc_pdf (ORB-915) — no new
 * download mechanism. `OrbotoClient.postBinary` / `getBinary` fetch the bytes.
 */
import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { OrbotoClient } from '../orboto-client.js';

interface BackupRun {
  id: string;
  jobId: string;
  startedAt: string;
  completedAt: string | null;
  status: string;
  fileSizeBytes: number | null;
  storagePath: string | null;
  errorMessage: string | null;
}

const mb = (n: number): string => `${Math.round((n / 1024 / 1024) * 10) / 10} MB`;

// ---------------------------------------------------------------------------
// orboto_create_full_backup
// ---------------------------------------------------------------------------

export const createFullBackupToolConfig = {
  title: 'Create + download a full workspace backup',
  description:
    'Create an on-demand FULL workspace backup (database + storage) right now and return the ZIP as a base64 application/zip resource attachment — create and download in one call. Requires admin:backup:export. For the scheduled named jobs use orboto_trigger_backup instead.',
  inputSchema: z.object({}).shape,
};

export function makeCreateFullBackupHandler(client: OrbotoClient) {
  return async (): Promise<CallToolResult> => {
    const { bytes, contentType } = await client.postBinary('/admin/backup/full');
    const base64 = Buffer.from(bytes).toString('base64');
    return {
      content: [
        { type: 'resource', resource: { uri: 'orboto://backup/full.zip', mimeType: contentType, blob: base64 } },
        { type: 'text', text: `Created full workspace backup (${mb(bytes.byteLength)}).` },
      ],
      structuredContent: { sizeBytes: bytes.byteLength, contentType },
    };
  };
}

// ---------------------------------------------------------------------------
// orboto_list_backups
// ---------------------------------------------------------------------------

export const listBackupsToolConfig = {
  title: 'List backup runs',
  description:
    'List recent backup runs (id, status, size, time) so you can pick one to download with orboto_download_backup. Requires admin:backup:read.',
  inputSchema: z.object({}).shape,
  annotations: { readOnlyHint: true, idempotentHint: true },
};

export function makeListBackupsHandler(client: OrbotoClient) {
  return async (): Promise<CallToolResult> => {
    const page = await client.get<{ items: BackupRun[] }>('/admin/backup/runs');
    const items = page.items ?? [];
    const lines = items.map(
      (r) => `- ${r.id} — ${r.status}${r.fileSizeBytes ? ` (${mb(r.fileSizeBytes)})` : ''} — ${r.completedAt ?? r.startedAt}`,
    );
    return {
      content: [{ type: 'text', text: items.length ? `Backup runs:\n${lines.join('\n')}` : 'No backup runs yet.' }],
      structuredContent: { runs: items },
    };
  };
}

// ---------------------------------------------------------------------------
// orboto_download_backup
// ---------------------------------------------------------------------------

export const downloadBackupToolConfig = {
  title: 'Download a stored backup run',
  description:
    'Download a stored backup run\'s ZIP by run id (from orboto_list_backups - e.g. the nightly job\'s run) as a base64 application/zip resource attachment. Requires admin:backup:read.',
  inputSchema: z.object({
    runId: z.string().uuid().describe('Backup run id from orboto_list_backups.'),
  }).shape,
};

export function makeDownloadBackupHandler(client: OrbotoClient) {
  return async ({ runId }: { runId: string }): Promise<CallToolResult> => {
    const { bytes, contentType } = await client.getBinary(`/admin/backup/runs/${runId}/download`);
    const base64 = Buffer.from(bytes).toString('base64');
    return {
      content: [
        { type: 'resource', resource: { uri: `orboto://backup/run-${runId}.zip`, mimeType: contentType, blob: base64 } },
        { type: 'text', text: `Downloaded backup run ${runId.slice(0, 8)} (${mb(bytes.byteLength)}).` },
      ],
      structuredContent: { runId, sizeBytes: bytes.byteLength, contentType },
    };
  };
}
