/**
 * ORB-1409 (epic ORB-1390) - `orboto_requirements_spec`.
 *
 * Generates the requirements specification (Pflichtenheft) as Markdown:
 * numbered functional requirements (FA-1, FA-1.1...) each traceable to its
 * ticket and tagged muss/soll/kann from priority, plus non-functional
 * requirements distilled from primer facts. `outlineVariant` picks the chapter
 * naming/order: `neutral` (default), `industry` (VDI-3694 style), or `software`
 * (IEEE-830 style). Private tickets/milestones are always excluded server-side.
 * Wraps `POST /projects/:id/requirements-spec/generate` with `format: 'markdown'`.
 * Money price mode needs budget:view on top of requirements_spec:generate (the
 * API returns 403 otherwise).
 *
 * The route existed since ORB-1391; ORB-1409 fills in the missing MCP + skill
 * surfaces (the Pflichtenheft feature shipped route + chat only).
 */
import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { OrbotoApiError, type OrbotoClient } from '../orboto-client.js';
import { resolveProjectByKey } from './shared.js';

interface MarkdownResponse {
  markdown: string;
  outlineVariant: string;
  locale: string;
  priceMode: string;
  aiSkipped: string | null;
  reviewFlags: { executiveSummaryGenerated: boolean; contentTranslated: boolean; translatedFields: number };
  languageFallback: boolean;
  languageNote: string | null;
}

const LOCALES = ['en', 'de', 'fr', 'it', 'es', 'sv'] as const;
const OUTLINE_VARIANTS = ['neutral', 'industry', 'software'] as const;

export const requirementsSpecToolConfig = {
  title: 'Requirements specification (Pflichtenheft)',
  description:
    'Generate the requirements specification (Pflichtenheft) as Markdown - numbered functional requirements (FA-1, FA-1.1...) each traceable to its ticket and tagged muss/soll/kann from priority, plus non-functional requirements distilled from primer facts. '
    + '`outlineVariant`: "neutral" (default), "industry" (VDI-3694 naming/order), or "software" (IEEE-830 naming/order). '
    + '`locale` sets the document language (en/de/fr/it/es/sv) independently of your own locale; structure labels are catalog-translated. '
    + '`priceMode`: "hours" (estimates, default), "money" (customer rates - needs the budget:view permission), or "lumpSum" (a flat price - pass `lumpSumAmount`). '
    + 'Private tickets and milestones are always excluded, and internal cost/overhead is never included. Requires the requirements_spec:generate permission on the project.',
  inputSchema: z.object({
    projectKey: z.string().min(1).describe('Project key (e.g. "ORB").'),
    outlineVariant: z.enum(OUTLINE_VARIANTS).default('neutral').describe('Outline variant (default "neutral"). "industry" = VDI-3694 style, "software" = IEEE-830 style.'),
    locale: z.enum(LOCALES).default('en').describe('Document language (default "en").'),
    priceMode: z.enum(['hours', 'money', 'lumpSum']).default('hours').describe('Pricing mode (default "hours"). "money" needs budget:view.'),
    lumpSumAmount: z.number().nonnegative().optional().describe('Flat price for priceMode="lumpSum".'),
    lumpSumCurrency: z.string().min(1).max(8).optional().describe('Currency for the lump sum (default EUR).'),
    showAssigneeNames: z.boolean().optional().describe('Include assignee names (opt-in, default off).'),
    showTicketKeys: z.boolean().optional().describe('Show ticket keys in the output (default on).'),
  }).shape,
  annotations: { readOnlyHint: true, idempotentHint: true },
};

export function makeRequirementsSpecHandler(client: OrbotoClient) {
  return async (input: {
    projectKey: string;
    outlineVariant?: (typeof OUTLINE_VARIANTS)[number];
    locale?: (typeof LOCALES)[number];
    priceMode?: 'hours' | 'money' | 'lumpSum';
    lumpSumAmount?: number;
    lumpSumCurrency?: string;
    showAssigneeNames?: boolean;
    showTicketKeys?: boolean;
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
      outlineVariant: input.outlineVariant ?? 'neutral',
      locale: input.locale ?? 'en',
      options,
      format: 'markdown',
    };

    let res: MarkdownResponse;
    try {
      res = await client.post<MarkdownResponse>(`/projects/${project.id}/requirements-spec/generate`, body);
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
        outlineVariant: res.outlineVariant,
        locale: res.locale,
        priceMode: res.priceMode,
        aiSkipped: res.aiSkipped,
        reviewFlags: res.reviewFlags,
        languageFallback: res.languageFallback,
        languageNote: res.languageNote,
      },
    };
  };
}
