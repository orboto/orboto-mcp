/**
 * ORB-1383 (epic ORB-1382) - `orboto_customer_report`.
 *
 * Generates the customer-facing project report as Markdown. Two presets:
 * `scope` (proposal: milestones + epics, no progress) and `status` (all
 * non-private tickets + progress). Private tickets/milestones are always
 * excluded server-side. Wraps `POST /projects/:id/customer-report/generate`
 * with `format: 'markdown'`. Money price mode needs budget:view on top of
 * customer_report:generate (the API returns 403 otherwise).
 */
import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { OrbotoApiError, type OrbotoClient } from '../orboto-client.js';
import { resolveProjectByKey } from './shared.js';

interface MarkdownResponse {
  markdown: string;
  preset: string;
  locale: string;
  priceMode: string;
  aiSkipped: string | null;
  reviewFlags: { executiveSummaryGenerated: boolean; contentTranslated: boolean; translatedFields: number };
}

const LOCALES = ['en', 'de', 'fr', 'it', 'es', 'sv'] as const;

export const customerReportToolConfig = {
  title: 'Customer project report',
  description:
    'Generate the customer-facing project report as Markdown. `preset`: "scope" (proposal character - milestones + epics, no progress/status) or "status" (status report - all non-private tickets + progress). '
    + '`locale` selects the report language (en/de/fr/it/es/sv) independently of your own locale; structure labels are catalog-translated. '
    + '`priceMode`: "hours" (estimates, default), "money" (customer rates - needs the budget:view permission), or "lumpSum" (a flat price - pass `lumpSumAmount`). '
    + 'Private tickets and milestones are always excluded, and internal cost/overhead is never included. Toggle sections with `sections` (overview, milestones, epics, tickets, budget). Requires the customer_report:generate permission on the project.',
  inputSchema: z.object({
    projectKey: z.string().min(1).describe('Project key (e.g. "ORB").'),
    preset: z.enum(['scope', 'status']).default('scope').describe('Report preset (default "scope").'),
    locale: z.enum(LOCALES).default('en').describe('Report language (default "en").'),
    priceMode: z.enum(['hours', 'money', 'lumpSum']).default('hours').describe('Pricing mode (default "hours"). "money" needs budget:view.'),
    lumpSumAmount: z.number().nonnegative().optional().describe('Flat price for priceMode="lumpSum".'),
    lumpSumCurrency: z.string().min(1).max(8).optional().describe('Currency for the lump sum (default EUR).'),
    showAssigneeNames: z.boolean().optional().describe('Include assignee names (opt-in, default off).'),
    showTicketKeys: z.boolean().optional().describe('Show ticket keys in the output (default on).'),
    sections: z.object({
      overview: z.boolean().optional(),
      milestones: z.boolean().optional(),
      epics: z.boolean().optional(),
      tickets: z.boolean().optional(),
      budget: z.boolean().optional(),
    }).optional().describe('Section toggles on top of the preset default.'),
  }).shape,
  annotations: { readOnlyHint: true },
};

export function makeCustomerReportHandler(client: OrbotoClient) {
  return async (input: {
    projectKey: string;
    preset?: 'scope' | 'status';
    locale?: (typeof LOCALES)[number];
    priceMode?: 'hours' | 'money' | 'lumpSum';
    lumpSumAmount?: number;
    lumpSumCurrency?: string;
    showAssigneeNames?: boolean;
    showTicketKeys?: boolean;
    sections?: Record<string, boolean>;
  }): Promise<CallToolResult> => {
    const project = await resolveProjectByKey(client, input.projectKey);
    const priceMode = input.priceMode ?? 'hours';

    const options: Record<string, unknown> = {
      priceMode,
      showAssigneeNames: input.showAssigneeNames ?? false,
      showTicketKeys: input.showTicketKeys ?? true,
    };
    if (priceMode === 'lumpSum') {
      options.lumpSum = {
        amount: input.lumpSumAmount ?? 0,
        currency: input.lumpSumCurrency ?? 'EUR',
      };
    }

    const body: Record<string, unknown> = {
      preset: input.preset ?? 'scope',
      locale: input.locale ?? 'en',
      options,
      format: 'markdown',
    };
    if (input.sections) body.sections = input.sections;

    let res: MarkdownResponse;
    try {
      res = await client.post<MarkdownResponse>(`/projects/${project.id}/customer-report/generate`, body);
    } catch (err) {
      if (err instanceof OrbotoApiError && err.status === 403 && priceMode === 'money') {
        return {
          content: [{ type: 'text', text: `Not permitted: money price mode needs the budget:view permission on ${project.key}.` }],
          structuredContent: { error: 'forbidden', requiredPermission: 'budget:view' },
        };
      }
      throw err;
    }

    return {
      content: [{ type: 'text', text: res.markdown }],
      structuredContent: {
        projectKey: project.key,
        preset: res.preset,
        locale: res.locale,
        priceMode: res.priceMode,
        aiSkipped: res.aiSkipped,
        reviewFlags: res.reviewFlags,
      },
    };
  };
}
