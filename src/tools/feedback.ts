/**
 * ORB-1910 - `orboto_report_feedback`: file a bug report / feedback / feature
 * request with the operator from inside the workspace (epic ORB-1907).
 *
 * Thin wrapper over the tenant relay (`POST /feedback`, ORB-1908): the
 * instance validates the closed schema, normalises the text and forwards
 * the report to the control plane with its own credential - this tool never
 * talks to the control plane and never learns the reporter's identity. It
 * checks `GET /feedback/availability` first so a self-hosted instance gets a
 * plain refusal naming the public issue tracker instead of a 503.
 *
 * The result carries the report id ONLY. The body is never echoed back into
 * the model's context: a report may quote hostile text (a bug reproduction
 * with an injected instruction), and re-reading it would be the one way this
 * tool could turn data into an instruction.
 */
import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { OrbotoClient } from '../orboto-client.js';

const PUBLIC_TRACKER = 'https://github.com/orboto/orboto-cli/issues';

export const reportFeedbackToolConfig = {
  title: 'Send feedback or a bug report to the operator',
  // ORB-1805 - kept short: every client pays for this text at connect;
  // orboto_help serves the full contract (caps, attachment policy, privacy).
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
  // A write that creates one report on the operator side; nothing is
  // removed or overwritten, and sending twice files two reports.
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
