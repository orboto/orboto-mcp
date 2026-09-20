/**
 * ORB-1301 - backup MCP tools. Four-way parity with the skill/UI, which can
 * create an on-demand full backup and download the ZIP. The MCP previously only
 * had orboto_trigger_backup (run a pre-configured named job).
 *
 * Binary archives are returned as MCP `resource` content attachments (base64
 * blob + mimeType + uri), exactly like orboto_export_doc_pdf (ORB-915) - no new
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
  sealed?: boolean;
  sealKeyFingerprint?: string | null;
  sealCustody?: 'platform' | 'customer' | 'passphrase' | null;
}

/**
 * ORB-1504 - an operator passphrase is deliberately NOT an MCP input: it
 * would land in the conversation transcript and the tool-call audit. The
 * passphrase paths are REST and `orboto backup --passphrase-stdin`; an agent
 * that must drive one uses the escape hatch `orboto_api_call`.
 */
const seal = (run: BackupRun): string =>
  run.sealed ? ` [encrypted, ${run.sealCustody ?? 'platform'} key${run.sealKeyFingerprint ? ` ${run.sealKeyFingerprint}` : ''}]` : '';

const mb = (n: number): string => `${Math.round((n / 1024 / 1024) * 10) / 10} MB`;

export const createFullBackupToolConfig = {
  title: 'Create + download a full workspace backup',
  description:
    'Create an on-demand FULL workspace backup (database + storage) and return it as a base64 resource attachment - one call; a background run this tool polls, minutes on a large workspace. Rows and file references share one snapshot; a missing file fails the run, never a partial archive. With backup encryption on the attachment is the sealed archive, not a ZIP. Requires admin:backup:export; scheduled jobs use orboto_trigger_backup.',
  inputSchema: z.object({}).shape,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
};

export function makeCreateFullBackupHandler(client: OrbotoClient) {
  return async (): Promise<CallToolResult> => {
    const { runId, sealed } = await client.post<{ runId: string; sealed: boolean }>('/admin/backup/full', {});
    const t0 = Date.now();
    for (;;) {
      await new Promise((r) => setTimeout(r, 3000));
      const run = await client.get<{ status: string; errorMessage: string | null }>(`/admin/backup/runs/${runId}`);
      if (run.status === 'success') break;
      if (run.status === 'failed') throw new Error(`backup export failed: ${run.errorMessage ?? 'unknown error'}`);
      if (Date.now() - t0 > 30 * 60_000) throw new Error(`backup export still running after 30 min - check run ${runId} in the backups list`);
    }
    const { bytes, contentType } = await client.getBinary(`/admin/backup/runs/${runId}/download`);
    const base64 = Buffer.from(bytes).toString('base64');
    const note = sealed
      ? ' The archive is encrypted with the instance key - it only restores where that key exists.'
      : '';
    return {
      content: [
        { type: 'resource', resource: { uri: sealed ? 'orboto://backup/full.zip.orbenc' : 'orboto://backup/full.zip', mimeType: contentType, blob: base64 } },
        { type: 'text', text: `Created full workspace backup (${mb(bytes.byteLength)}), run ${runId}.${note}` },
      ],
      structuredContent: { sizeBytes: bytes.byteLength, contentType, runId, sealed },
    };
  };
}

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
      (r) => `- ${r.id} - ${r.status}${r.fileSizeBytes ? ` (${mb(r.fileSizeBytes)})` : ''} - ${r.completedAt ?? r.startedAt}${seal(r)}`,
    );
    return {
      content: [{ type: 'text', text: items.length ? `Backup runs:\n${lines.join('\n')}` : 'No backup runs yet.' }],
      structuredContent: { runs: items },
    };
  };
}

export const downloadBackupToolConfig = {
  title: 'Download a stored backup run',
  description:
    'Download a stored backup run by run id (from orboto_list_backups) as a base64 resource attachment; an encrypted run downloads sealed and needs its key to restore. Requires admin:backup:read.',
  inputSchema: z.object({
    runId: z.string().uuid().describe('Backup run id from orboto_list_backups.'),
  }).shape,
  annotations: { readOnlyHint: true, idempotentHint: true },
};

export function makeDownloadBackupHandler(client: OrbotoClient) {
  return async ({ runId }: { runId: string }): Promise<CallToolResult> => {
    const { bytes, contentType } = await client.getBinary(`/admin/backup/runs/${runId}/download`);
    const base64 = Buffer.from(bytes).toString('base64');
    return {
      content: [
        { type: 'resource', resource: { uri: `orboto://backup/run-${runId}${contentType.includes('sealed') ? '.zip.orbenc' : '.zip'}`, mimeType: contentType, blob: base64 } },
        { type: 'text', text: `Downloaded backup run ${runId.slice(0, 8)} (${mb(bytes.byteLength)}).` },
      ],
      structuredContent: { runId, sizeBytes: bytes.byteLength, contentType },
    };
  };
}
