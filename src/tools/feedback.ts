/**
 * ORB-1910 - `orboto_report_feedback`: file a bug report / feedback / feature
 * request with the operator from inside the workspace (epic ORB-1907).
 *
 * @see ORB-1908
 */
import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { OrbotoClient } from '../orboto-client.js';

const PUBLIC_TRACKER = 'https://github.com/orboto/orboto-cli/issues';

export const reportFeedbackToolConfig = {
  title: 'Send feedback or a bug report to the operator',
  description:
    'File a bug report, feedback or feature request with the orboto operator from inside this workspace. Relayed without your identity; up to 3 png/jpeg/txt attachments (2 MB each, base64). Refused on self-hosted instances without an operator link. Answers with the report id only.',
  inputSchema: z.object({
    kind: z.enum(['bug', 'feedback', 'feature']),
    title: z.string().min(1).max(200),
    body: z.string().min(1).max(20_000),
    steps: z.string().max(4_000).optional(),
    expected: z.string().max(4_000).optional(),
    actual: z.string().max(4_000).optional(),
    page: z.string().max(300).optional().describe('Route path only, e.g. "/projects/ORB".'),
    ticketKey: z.string().max(64).optional(),
    projectKey: z.string().max(32).optional(),
    attachments: z.array(z.object({
      filename: z.string().min(1).max(120),
      mimetype: z.enum(['image/png', 'image/jpeg', 'text/plain']),
      contentBase64: z.string().min(1),
    })).max(3).optional(),
  }).shape,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
};

export interface ReportFeedbackArgs {
  kind: 'bug' | 'feedback' | 'feature';
  title: string;
  body: string;
  steps?: string;
  expected?: string;
  actual?: string;
  page?: string;
  ticketKey?: string;
  projectKey?: string;
  attachments?: Array<{ filename: string; mimetype: 'image/png' | 'image/jpeg' | 'text/plain'; contentBase64: string }>;
}

export function makeReportFeedbackHandler(client: OrbotoClient) {
  return async (args: ReportFeedbackArgs): Promise<CallToolResult> => {
    const availability = await client.get<{ available: boolean; reason?: string }>('/feedback/availability');
    if (!availability.available) {
      throw new Error(
        `This instance cannot relay feedback to an operator (${availability.reason ?? 'no relay credential'}) - it is self-hosted or not linked to the control plane. Report the issue on the public tracker instead: ${PUBLIC_TRACKER}`,
      );
    }
    const context = args.ticketKey || args.projectKey
      ? { ...(args.ticketKey ? { ticketKey: args.ticketKey } : {}), ...(args.projectKey ? { projectKey: args.projectKey } : {}) }
      : undefined;
    const report = {
      kind: args.kind,
      title: args.title,
      body: args.body,
      ...(args.steps !== undefined ? { steps: args.steps } : {}),
      ...(args.expected !== undefined ? { expected: args.expected } : {}),
      ...(args.actual !== undefined ? { actual: args.actual } : {}),
      ...(args.page !== undefined ? { page: args.page } : {}),
      ...(context ? { context } : {}),
      ...(args.attachments?.length ? { attachments: args.attachments } : {}),
    };
    const res = await client.post<{ reportId: string }>('/feedback', report);
    const attachmentCount = args.attachments?.length ?? 0;
    return {
      content: [{ type: 'text', text: `Report ${res.reportId} sent to the operator (${args.kind}, ${attachmentCount} attachment${attachmentCount === 1 ? '' : 's'}).` }],
      structuredContent: { reportId: res.reportId, kind: args.kind, attachments: attachmentCount },
    };
  };
}
