/**
 * ORB-1222 - `orboto_portfolio_summary`. Read-only portfolio / program-level
 * cross-project rollup. With no `portfolioId` it lists the portfolios the
 * caller can see; with one it returns the aggregate rollup (RAG per project,
 * progress, budget, Earned Value, at-risk milestones). The rollup is
 * ACL-filtered server-side to what the caller may see - a project the caller
 * isn't a member of is omitted from every aggregate. Requires the
 * admin:portfolio:read permission (the API returns 403 otherwise).
 */
import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { OrbotoApiError, type OrbotoClient } from '../orboto-client.js';

interface PortfolioListItem {
  id: string;
  name: string;
  projectCount: number;
}

export const portfolioSummaryToolConfig = {
  title: 'Portfolio summary',
  description:
    'Read a portfolio / program-level cross-project rollup. With no `portfolioId`, lists the portfolios you can see (id, name, project count). With a `portfolioId`, returns the aggregate rollup: per-project RAG (red/amber/green) health, overall progress (done/total tickets), effort hours, aggregate Earned Value (SPI/CPI across projects with a baseline), a per-currency budget rollup, and the at-risk milestones (overdue or soon-due) across the whole portfolio. '
    + 'Every figure is ACL-filtered server-side to only the projects you are a member of (super-admins see all) and the tickets / milestones / budgets you may see - so it never leaks a project you cannot otherwise access. Requires the admin:portfolio:read permission (you get a permission error otherwise).',
  inputSchema: z.object({
    portfolioId: z.string().uuid().optional().describe('Portfolio UUID. Omit to list all portfolios you can see.'),
  }).shape,
  annotations: { readOnlyHint: true, idempotentHint: true },
};

export function makePortfolioSummaryHandler(client: OrbotoClient) {
  return async (input: { portfolioId?: string }): Promise<CallToolResult> => {
    try {
      if (!input.portfolioId) {
        const list = await client.get<PortfolioListItem[]>('/admin/portfolios');
        const lines = list.length
          ? list.map((p) => `- ${p.name} (${p.projectCount} projects) - id ${p.id}`).join('\n')
          : 'No portfolios found.';
        return {
          content: [{ type: 'text', text: `Portfolios:\n${lines}` }],
          structuredContent: { portfolios: list },
        };
      }
      const rollup = await client.get<unknown>(`/admin/portfolios/${input.portfolioId}/rollup`);
      return {
        content: [{ type: 'text', text: `Portfolio rollup:\n${JSON.stringify(rollup, null, 2)}` }],
        structuredContent: { rollup },
      };
    } catch (err) {
      if (err instanceof OrbotoApiError && err.status === 403) {
        return {
          content: [{ type: 'text', text: 'Not permitted: portfolio reporting needs the admin:portfolio:read permission.' }],
          structuredContent: { error: 'forbidden', requiredPermission: 'admin:portfolio:read' },
        };
      }
      if (err instanceof OrbotoApiError && err.status === 404) {
        return {
          content: [{ type: 'text', text: 'Portfolio not found.' }],
          structuredContent: { error: 'not_found' },
        };
      }
      throw err;
    }
  };
}
