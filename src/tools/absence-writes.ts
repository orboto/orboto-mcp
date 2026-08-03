/**
 * ORB-933 — write-side MCP tools for absences and the two admin tables
 * that ride alongside them (public holidays, company closures).
 *
 *   - orboto_update_public_holiday   — PATCH /admin/public-holidays/:id
 *   - orboto_update_company_closure  — PATCH /admin/company-closures/:id
 *   - orboto_update_absence          — PATCH /absences/:id
 *
 * Today these surfaces only had POST + DELETE — typo correction or date
 * fix meant delete + recreate, losing the original row id. PATCH fills
 * that gap. Listing endpoints stay on the existing routes (no read tools
 * here yet — that's Phase 3 of the CRUD parity epic, ORB-935).
 */
import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { OrbotoClient } from '../orboto-client.js';

interface PublicHolidayRow {
  id: string;
  name: string;
  date: string;
  countryCode: string | null;
  regionCode: string | null;
  isRecurring: boolean;
}

interface CompanyClosureRow {
  id: string;
  name: string;
  startDate: string;
  endDate: string;
  note: string | null;
}

interface AbsenceRow {
  id: string;
  userId: string;
  typeId: string;
  startDate: string;
  endDate: string;
  durationDays: string | number;
  status: 'draft' | 'pending' | 'approved' | 'rejected' | 'cancelled';
  note: string | null;
}

// ---------------------------------------------------------------------------
// orboto_update_public_holiday
// ---------------------------------------------------------------------------

export const updatePublicHolidayToolConfig = {
  title: 'Edit a public holiday',
  description:
    'Correct a typo or wrong date on a public holiday without losing the row id. Admin-only (`admin:absences:write`). Pass only the fields you want to change; at least one field is required.',
  inputSchema: z.object({
    id: z.string().uuid(),
    name: z.string().min(1).max(100).optional(),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('YYYY-MM-DD'),
    countryCode: z.string().max(10).nullable().optional(),
    regionCode: z.string().max(10).nullable().optional(),
    isRecurring: z.boolean().optional(),
  }).shape,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
};

export function makeUpdatePublicHolidayHandler(client: OrbotoClient) {
  return async (input: {
    id: string;
    name?: string;
    date?: string;
    countryCode?: string | null;
    regionCode?: string | null;
    isRecurring?: boolean;
  }): Promise<CallToolResult> => {
    const { id, ...patch } = input;
    const row = await client.patch<PublicHolidayRow>(`/admin/public-holidays/${id}`, patch);
    return {
      content: [{ type: 'text', text: `Public holiday ${row.id} updated (${row.name} on ${row.date}).` }],
      structuredContent: row as unknown as Record<string, unknown>,
    };
  };
}

// ---------------------------------------------------------------------------
// orboto_update_company_closure
// ---------------------------------------------------------------------------

export const updateCompanyClosureToolConfig = {
  title: 'Edit a company closure',
  description:
    'Update a workspace-wide non-working block (company offsite, holiday shutdown). Admin-only (`admin:absences:write`). Pass only the fields you want to change; at least one field is required. If only one of `startDate`/`endDate` is passed, the other is left as-is — the API still validates start ≤ end after the partial patch.',
  inputSchema: z.object({
    id: z.string().uuid(),
    name: z.string().min(1).optional(),
    startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('YYYY-MM-DD'),
    endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('YYYY-MM-DD'),
    note: z.string().nullish(),
  }).shape,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
};

export function makeUpdateCompanyClosureHandler(client: OrbotoClient) {
  return async (input: {
    id: string;
    name?: string;
    startDate?: string;
    endDate?: string;
    note?: string | null;
  }): Promise<CallToolResult> => {
    const { id, ...patch } = input;
    const row = await client.patch<CompanyClosureRow>(`/admin/company-closures/${id}`, patch);
    return {
      content: [{ type: 'text', text: `Company closure ${row.id} updated (${row.name}, ${row.startDate} → ${row.endDate}).` }],
      structuredContent: row as unknown as Record<string, unknown>,
    };
  };
}

// ---------------------------------------------------------------------------
// orboto_update_absence
// ---------------------------------------------------------------------------

export const updateAbsenceToolConfig = {
  title: 'Edit a pending or draft absence request',
  description:
    'Edit your own absence request before a reviewer acts on it. Locked once the status is `approved`, `rejected`, or `cancelled` — those transitions go through the approve / reject / cancel endpoints, not this one. Caller must be the absence owner or a super-admin. `durationDays` is recomputed automatically when dates move (uses the owner\'s working-day rules + holidays + closures).',
  inputSchema: z.object({
    id: z.string().uuid(),
    typeId: z.string().uuid().optional().describe('Absence-type id (vacation, sick, etc.).'),
    startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('YYYY-MM-DD'),
    endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('YYYY-MM-DD'),
    note: z.string().nullish(),
  }).shape,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
};

export function makeUpdateAbsenceHandler(client: OrbotoClient) {
  return async (input: {
    id: string;
    typeId?: string;
    startDate?: string;
    endDate?: string;
    note?: string | null;
  }): Promise<CallToolResult> => {
    const { id, ...patch } = input;
    const row = await client.patch<AbsenceRow>(`/absences/${id}`, patch);
    return {
      content: [{
        type: 'text',
        text: `Absence ${row.id} updated (${row.startDate} → ${row.endDate}, ${row.durationDays} days, status=${row.status}).`,
      }],
      structuredContent: row as unknown as Record<string, unknown>,
    };
  };
}
