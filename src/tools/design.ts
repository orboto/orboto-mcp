/**
 * ORB-3188 - `orboto_design` (concept ORB-D205, 8.3): the design review record for an agent. `get` reads a design by its handle (doc key, ticket key or
 * a UUID; a build ticket names the design it is built from) or lists a project's designs by its key. The actions review, question and answer and the get
 * payload fields section and point come with rows A2 and A3; mark, edit, link, unlink and unmark are operator tail endpoints reached through orboto_api_call.
 */
import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { OrbotoClient } from '../orboto-client.js';

/** Mirror of `BuildsFromWarningSchema` (packages/shared-schema/src/design-reviews.ts, ORB-3188), held by its drift test in ticket-writes.test.ts. */
export interface BuildsFromWarning { code: 'design_not_found' | 'forbidden' | 'link_failed'; handle: string; errorKey: string }

export const DESIGN_ACTIONS = ['get'] as const;
type Action = (typeof DESIGN_ACTIONS)[number];

/** Mirror of `DesignSubjectKindSchema` and `DesignFormSchema` in packages/shared-schema/src/design-reviews.ts, held by the drift test. */
export const DESIGN_KINDS = ['architecture', 'design', 'concept', 'spec', 'plan', 'ticket_set'] as const;
export const DESIGN_FORMS = ['compact', 'full'] as const;

/** Mirror of the `get` payload: `DesignGetQuerySchema` plus the list cursor of `DesignListQuerySchema`. */
export const DesignGetPayloadSchema = z.object({
  form: z.enum(DESIGN_FORMS).optional(),
  cursor: z.string().max(2048).optional(),
}).strict();

export const designToolConfig = {
  title: 'Design review',
  description: 'Design records: get (handle: design, ticket or project key; payload form, cursor). review, question, answer and payload section, point come with A2 and A3. Mark, link: orboto_api_search "design".',
  inputSchema: z.object({
    action: z.enum(DESIGN_ACTIONS),
    handle: z.string(),
    payload: z.record(z.string(), z.unknown()).optional(),
  }).shape,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
};

type Args = { action: Action; handle: string; payload?: Record<string, unknown> };

interface Subject {
  id: string; handle: string; kind: string; form: string; touchesContract: boolean; fingerprint: string; fingerprintAlgo: string;
  anchor: { type: string; id: string; key: string | null; title: string };
  homeProject: { id: string; key: string; name: string };
  author: { kind: string; label: string; model: string | null; modelSource: string | null };
  buildTickets: Array<{ ticketId: string; key: string | null; title: string }>;
  buildTicketsVisible: number; buildTicketsOmitted: number; buildTicketsHidden: number;
  updatedAt: string;
}
interface Row { id: string; handle: string; kind: string; touchesContract: boolean; authorLabel: string; authorModel: string | null; buildTicketsVisible: number; updatedAt: string; anchor: { title: string } }

const PROJECT_KEY = /^[A-Za-z][A-Za-z0-9_]{0,31}$/;

function result(structured: Record<string, unknown>, text: string): CallToolResult {
  return { content: [{ type: 'text', text }], structuredContent: structured };
}

function subjectText(s: Subject): string {
  const model = s.author.model ? ` on ${s.author.model}${s.author.modelSource ? ` (${s.author.modelSource})` : ''}` : '';
  const lines = [
    `${s.handle} ${s.kind}${s.touchesContract ? ' touches-contract' : ''} fp=${s.fingerprint} home=${s.homeProject.key} by ${s.author.label} (${s.author.kind})${model} - ${s.anchor.title}`,
    ...s.buildTickets.map((t) => `- builds ${t.key ?? t.ticketId} ${t.title}`),
  ];
  const left = [s.buildTicketsOmitted ? `${s.buildTicketsOmitted} more build tickets (payload form=full)` : '', s.buildTicketsHidden ? `${s.buildTicketsHidden} build tickets you cannot see` : ''].filter(Boolean);
  if (left.length) lines.push(left.join('; '));
  return lines.join('\n');
}

function rowText(r: Row): string {
  return `- ${r.handle} ${r.kind}${r.touchesContract ? ' touches-contract' : ''} by ${r.authorLabel}${r.authorModel ? ` on ${r.authorModel}` : ''}, ${r.buildTicketsVisible} build tickets, changed ${r.updatedAt} - ${r.anchor.title}`;
}

export function makeDesignHandler(client: OrbotoClient) {
  return async (args: Args): Promise<CallToolResult> => {
    const handle = args.handle?.trim();
    if (!handle) throw new Error(`${args.action} needs handle.`);
    const payload = DesignGetPayloadSchema.safeParse(args.payload ?? {});
    if (!payload.success) throw new Error(`get payload: ${payload.error.issues.map((i) => `${i.path.join('.') || 'payload'} ${i.message}`).join('; ')}`);
    if (PROJECT_KEY.test(handle) && !handle.includes('-')) {
      const query = new URLSearchParams({ projectId: handle, limit: '50' });
      if (payload.data.cursor) query.set('cursor', payload.data.cursor);
      const out = await client.get<{ items: Row[]; nextCursor: string | null }>(`/design-subjects?${query}`);
      const lines = out.items.length ? out.items.map(rowText) : [`${handle} has no design you can see.`];
      if (out.nextCursor) lines.push(`More: payload cursor=${out.nextCursor}`);
      return result(out, lines.join('\n'));
    }
    const form = payload.data.form ?? 'compact';
    const s = await client.get<Subject>(`/design-subjects/${encodeURIComponent(handle)}${form === 'full' ? '?form=full' : ''}`);
    return result(s as unknown as Record<string, unknown>, subjectText(s));
  };
}
