/**
 * ORB-2229 - `orboto_secret_scan`, the admin secret scan.
 */
import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { OrbotoClient } from '../orboto-client.js';

interface SecretFinding {
  class: string;
  line: number;
  column: number;
  preview: string;
  length: number;
}

interface SecretScanHit {
  entity: string;
  id: string;
  label: string;
  field: string;
  projectKey: string | null;
  spaceVisibility: string | null;
  webUrl: string | null;
  findings: SecretFinding[];
  redacted: boolean;
}

interface SecretScanReport {
  scannedAt: string;
  scanned: Record<string, number>;
  hits: SecretScanHit[];
  redacted: number;
}

export const secretScanToolConfig = {
  title: 'Secret scan',
  description:
    'Sweeps docs, revisions, comments, ticket bodies, primer facts and embedding previews for secret-shaped values already stored (ORB-2229, same detector as the write guard). Reports entity, class, position and a masked preview, never the value. redact:true replaces the value, purges the doc\'s revisions, deletes its embedding chunks and re-enqueues it. admin:system:read (write for redact).',
  inputSchema: z.object({
    redact: z.boolean().optional().describe('Replace every value found and purge its history (default false).'),
    limit: z.number().int().min(1).max(1000).optional().describe('Max hits (1-1000, default 200).'),
  }).shape,
  outputSchema: z.object({
    scannedAt: z.string(),
    scanned: z.record(z.number()),
    hitCount: z.number(),
    redactedCount: z.number(),
    hits: z.array(z.object({
      entity: z.string(),
      id: z.string(),
      label: z.string(),
      field: z.string(),
      projectKey: z.string().nullable(),
      spaceVisibility: z.string().nullable(),
      webUrl: z.string().nullable(),
      classes: z.array(z.string()),
      redacted: z.boolean(),
    })),
  }).shape,
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
};

export function makeSecretScanHandler(client: OrbotoClient) {
  return async (args: { redact?: boolean; limit?: number }): Promise<CallToolResult> => {
    const report = await client.post<SecretScanReport>('/admin/content/secret-scan', {
      redact: args.redact ?? false,
      limit: args.limit ?? 200,
    });

    const lines: string[] = [];
    const counts = Object.entries(report.scanned).map(([k, n]) => `${k} ${n}`).join(', ');
    lines.push(`Secret scan at ${report.scannedAt} - scanned ${counts}`);
    if (report.hits.length === 0) {
      lines.push('No secret-shaped value found.');
    } else {
      for (const hit of report.hits) {
        const where = [hit.label, hit.projectKey ? `(${hit.projectKey})` : null, hit.spaceVisibility ? `[space: ${hit.spaceVisibility}]` : null].filter(Boolean).join(' ');
        const state = hit.redacted ? ' - redacted' : '';
        lines.push(`${hit.entity} ${where}${state}`);
        for (const f of hit.findings) {
          lines.push(`    ${f.class} in ${hit.field} at line ${f.line}, column ${f.column} (${f.preview}, ${f.length} chars)`);
        }
      }
      lines.push(report.redacted > 0
        ? `Redacted ${report.redacted} rows; rotate every credential listed above.`
        : `${report.hits.length} hits; rotate every credential listed above, then run with redact: true.`);
    }

    return {
      content: [{ type: 'text', text: lines.join('\n') }],
      structuredContent: {
        scannedAt: report.scannedAt,
        scanned: report.scanned,
        hitCount: report.hits.length,
        redactedCount: report.redacted,
        hits: report.hits.map((h) => ({
          entity: h.entity, id: h.id, label: h.label, field: h.field,
          projectKey: h.projectKey, spaceVisibility: h.spaceVisibility, webUrl: h.webUrl,
          classes: h.findings.map((f) => f.class), redacted: h.redacted,
        })),
      },
    };
  };
}
