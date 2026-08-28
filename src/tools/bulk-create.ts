/**
 * ORB-1694 - bulk create + bulk dependency writes.
 *
 * Measured over 32 transcripts: `orboto_create_ticket` ran in 48
 * consecutive-call clusters (longest 49 in a row) and
 * `orboto_add_ticket_dependency` in 13 (longest 27) - the two longest
 * runs in the whole tool corpus, each call paying a full round trip
 * plus a ~1.1k-character response into the calling agent's context.
 * These two tools collapse a milestone-planning session into one call
 * with ONE compact aggregated response.
 *
 * Same family contract as bulk-writes.ts: serial per-item against the
 * existing single-item REST endpoints (per-tenant rate-limit posture),
 * per-item error reporting - one bad item never drops the rest - and a
 * `{successful, failed}` outcome the model can branch on. Duplicate
 * findings are reported COMPACTLY: one line per flagged draft, never
 * the single-tool's full warning block (pairs with ORB-1693).
 */
import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { OrbotoApiError, type OrbotoClient } from '../orboto-client.js';
import { resolveProjectByKey, resolveTicketByKey, type TicketRow } from './shared.js';
import { resolveMilestoneByNameOrId } from './milestones.js';

interface SimilarWarning {
  id: string;
  ticketKey: string | null;
  title: string;
  similarity: number;
  matchMode: 'tsvector' | 'embedding';
}

interface LanguageWarning { detected: string; expected: string }

// ---------------------------------------------------------------------------
// orboto_bulk_create_tickets
// ---------------------------------------------------------------------------

const TicketDraftSchema = z.object({
  title: z.string().min(1).max(255),
  description: z.string().optional(),
  type: z.enum(['task', 'bug', 'story', 'epic']).optional().describe('Default: task.'),
  priority: z.enum(['blocker', 'high', 'normal', 'low', 'trivial']).optional().describe('Default: normal.'),
  deliveryMode: z.enum(['implementation', 'docs', 'review', 'admin', 'epic']).optional(),
  milestone: z.string().optional().describe('Milestone key (e.g. "ORB-M3"), name, or UUID. Overrides the call-level milestone for this draft.'),
  assigneeEmails: z.array(z.string().email()).optional(),
  labels: z.array(z.string()).optional().describe('Label names - must already exist on the project.'),
  parentTicketKey: z.string().optional(),
  dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  isPrivate: z.boolean().optional(),
});

export const bulkCreateTicketsToolConfig = {
  title: 'Create many tickets in one call',
  description:
    'Create up to 50 tickets in one call - the right tool whenever you are about to create more than ~3 tickets (milestone planning, epic breakdown, import). Per-draft error isolation: a rejected draft (bad label, language block, hard duplicate-block) is reported in `failed` while the rest are still created. Duplicate detection runs per draft and is reported compactly - one line per flagged draft in `duplicateFlags`; review those before treating them as new work. A call-level `milestone` / `parentTicketKey` applies to every draft unless the draft overrides it. Drafts are created in array order, so a draft can NOT reference a sibling draft as parent - create parents first (or in a first call).',
  inputSchema: z.object({
    projectKey: z.string().min(1).describe('Project key (e.g. "ACME") - all drafts land here.'),
    tickets: z.array(TicketDraftSchema).min(1).max(50).describe('The ticket drafts, created in order.'),
    milestone: z.string().optional().describe('Call-level milestone (key/name/UUID) applied to every draft without its own.'),
    parentTicketKey: z.string().optional().describe('Call-level parent applied to every draft without its own.'),
    allowLanguageMismatch: z.boolean().optional().describe('Override strict ticket-language enforcement (ORB-990) for every draft. Only after a previous call was blocked AND the language is intentional.'),
  }).shape,
  outputSchema: z.object({
    created: z.array(z.string()).describe('Ticket keys, in draft order.'),
    failed: z.array(z.object({ index: z.number().int(), title: z.string(), error: z.string() })),
    duplicateFlags: z.array(z.object({
      key: z.string().describe('The NEW ticket that was created but flagged.'),
      matches: z.array(z.object({ ticketKey: z.string().nullable(), similarity: z.number() })),
    })),
    languageWarnings: z.number().int().describe('How many created drafts carried a language-mismatch warning.'),
  }).shape,
  annotations: { readOnlyHint: false, idempotentHint: false },
};

export function makeBulkCreateTicketsHandler(client: OrbotoClient) {
  return async (input: {
    projectKey: string;
    tickets: Array<z.infer<typeof TicketDraftSchema>>;
    milestone?: string;
    parentTicketKey?: string;
    allowLanguageMismatch?: boolean;
  }): Promise<CallToolResult> => {
    const project = await resolveProjectByKey(client, input.projectKey);

    // Resolve shared + per-draft milestone/parent references ONCE per
    // distinct value - 20 drafts on one milestone = one lookup.
    const milestoneIds = new Map<string, string>();
    const resolveMilestone = async (ref: string): Promise<string> => {
      const cached = milestoneIds.get(ref);
      if (cached) return cached;
      const id = (await resolveMilestoneByNameOrId(client, project.id, ref)).id;
      milestoneIds.set(ref, id);
      return id;
    };
    const parentIds = new Map<string, string>();
    const resolveParent = async (key: string): Promise<string> => {
      const cached = parentIds.get(key);
      if (cached) return cached;
      const id = (await resolveTicketByKey(client, key)).id;
      parentIds.set(key, id);
      return id;
    };

    const created: string[] = [];
    const failed: Array<{ index: number; title: string; error: string }> = [];
    const duplicateFlags: Array<{ key: string; matches: Array<{ ticketKey: string | null; similarity: number }> }> = [];
    let languageWarnings = 0;

    for (let i = 0; i < input.tickets.length; i++) {
      const draft = input.tickets[i];
      try {
        const body: Record<string, unknown> = {
          title: draft.title,
          description: draft.description ?? null,
          type: draft.type ?? 'task',
          priority: draft.priority ?? 'normal',
          isPrivate: draft.isPrivate ?? false,
          ...(draft.deliveryMode ? { deliveryMode: draft.deliveryMode } : {}),
          ...(draft.dueDate ? { dueDate: draft.dueDate } : {}),
          ...(draft.labels?.length ? { labelNames: draft.labels } : {}),
          ...(draft.assigneeEmails?.length ? { assigneeEmails: draft.assigneeEmails } : {}),
        };
        const milestoneRef = draft.milestone ?? input.milestone;
        if (milestoneRef) body.milestoneId = await resolveMilestone(milestoneRef);
        const parentRef = draft.parentTicketKey ?? input.parentTicketKey;
        if (parentRef) body.parentTicketId = await resolveParent(parentRef);

        const qs = input.allowLanguageMismatch ? '?allowLanguageMismatch=true' : '';
        const res = await client.post<TicketRow & {
          similarWarnings?: SimilarWarning[];
          languageWarning?: LanguageWarning;
          duplicateCheckDeferred?: boolean;
        }>(`/projects/${project.id}/tickets${qs}`, body);

        created.push(res.ticketKey ?? res.id);
        if (res.languageWarning) languageWarnings++;
        const warnings = res.similarWarnings ?? [];
        if (warnings.length > 0) {
          duplicateFlags.push({
            key: res.ticketKey ?? res.id,
            matches: warnings.slice(0, 3).map((w) => ({
              ticketKey: w.ticketKey,
              similarity: Math.round(w.similarity * 100) / 100,
            })),
          });
        }
      } catch (err) {
        const msg = err instanceof OrbotoApiError
          ? `${err.status}: ${err.message}`
          : err instanceof Error ? err.message : String(err);
        failed.push({ index: i, title: draft.title.slice(0, 60), error: msg.slice(0, 200) });
      }
    }

    const lines = [
      `bulk_create - ${created.length} created, ${failed.length} failed${duplicateFlags.length ? `, ${duplicateFlags.length} flagged as possible duplicates` : ''}${languageWarnings ? `, ${languageWarnings} language warnings` : ''}.`,
    ];
    if (created.length > 0) lines.push(`Created: ${created.join(', ')}`);
    for (const f of duplicateFlags) {
      lines.push(`⚠ ${f.key} may duplicate ${f.matches.map((m) => `${m.ticketKey ?? '?'} (${m.similarity})`).join(', ')} - review before treating as new work.`);
    }
    for (const f of failed) {
      lines.push(`✗ draft ${f.index} "${f.title}": ${f.error}`);
    }
    if (languageWarnings > 0) {
      lines.push(`⚠ ${languageWarnings} draft(s) in a non-workspace language - consider rewriting for search/duplicate consistency.`);
    }

    return {
      content: [{ type: 'text', text: lines.join('\n') }],
      structuredContent: { created, failed, duplicateFlags, languageWarnings },
    };
  };
}

// ---------------------------------------------------------------------------
// orboto_bulk_add_ticket_dependencies
// ---------------------------------------------------------------------------

export const bulkAddTicketDependenciesToolConfig = {
  title: 'Add many ticket dependencies in one call',
  description:
    'Create up to 200 blocked-by edges in one call - use instead of repeated orboto_add_ticket_dependency whenever wiring more than ~3 edges (dependency graphs after a bulk create). Each pair is (ticketKey, dependsOnKey) = "ticket is blocked by dependsOn". Per-pair error isolation; an already-existing edge counts as ok, a cycle rejection lands in `failed` with the API\'s reason.',
  inputSchema: z.object({
    pairs: z.array(z.object({
      ticketKey: z.string().min(3).describe('The blocked ticket.'),
      dependsOnKey: z.string().min(3).describe('The blocking ticket.'),
    })).min(1).max(200),
  }).shape,
  outputSchema: z.object({
    successful: z.array(z.string()).describe('"A->B" pairs written (or already present).'),
    failed: z.array(z.object({ pair: z.string(), error: z.string() })),
  }).shape,
  annotations: { readOnlyHint: false, idempotentHint: true },
};

export function makeBulkAddTicketDependenciesHandler(client: OrbotoClient) {
  return async (input: { pairs: Array<{ ticketKey: string; dependsOnKey: string }> }): Promise<CallToolResult> => {
    // Resolve every distinct key once, not once per edge.
    const resolved = new Map<string, TicketRow>();
    const resolve = async (key: string): Promise<TicketRow> => {
      const cached = resolved.get(key);
      if (cached) return cached;
      const t = await resolveTicketByKey(client, key);
      resolved.set(key, t);
      return t;
    };

    const successful: string[] = [];
    const failed: Array<{ pair: string; error: string }> = [];
    for (const { ticketKey, dependsOnKey } of input.pairs) {
      const label = `${ticketKey}->${dependsOnKey}`;
      try {
        const ticket = await resolve(ticketKey);
        const dependsOn = await resolve(dependsOnKey);
        try {
          await client.post(
            `/projects/${ticket.projectId}/tickets/${ticket.id}/dependencies`,
            { dependsOnId: dependsOn.id },
          );
        } catch (err) {
          // 409 = edge already exists - idempotent success, same as the
          // single-edge tool.
          if (!(err instanceof OrbotoApiError && err.status === 409)) throw err;
        }
        successful.push(label);
      } catch (err) {
        const msg = err instanceof OrbotoApiError
          ? `${err.status}: ${err.message}`
          : err instanceof Error ? err.message : String(err);
        failed.push({ pair: label, error: msg.slice(0, 200) });
      }
    }

    const lines = [`bulk_add_dependencies - ${successful.length} ok, ${failed.length} failed.`];
    for (const f of failed) lines.push(`✗ ${f.pair}: ${f.error}`);
    return {
      content: [{ type: 'text', text: lines.join('\n') }],
      structuredContent: { successful, failed },
    };
  };
}
