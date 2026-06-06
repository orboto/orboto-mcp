/**
 * ORB-1037 — RACI agent surfaces.
 *   - orboto_raci      : read the RACI matrix (tickets x members x role).
 *   - orboto_set_raci  : set a person's R/A/C/I role on a ticket.
 * Both wrap the same routes the web UI uses. Setting a second Accountable
 * returns the single-A error from Phase 1 as a friendly message, not a throw.
 */
import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { OrbotoApiError, type OrbotoClient } from '../orboto-client.js';
import { resolveProjectByKey, resolveTicketByKey } from './shared.js';

const ROLES = ['R', 'A', 'C', 'I'] as const;
type Role = (typeof ROLES)[number];

interface MemberRow {
  userId: string;
  user: { email: string; fullName: string };
}

async function resolveMemberId(client: OrbotoClient, projectId: string, email: string): Promise<string> {
  const members = await client.get<MemberRow[]>(`/projects/${projectId}/members`);
  const m = members.find((x) => x.user.email.toLowerCase() === email.toLowerCase());
  if (!m) throw new Error(`No project member with email "${email}".`);
  return m.userId;
}

// ---------------------------------------------------------------------------
// orboto_raci — read the matrix
// ---------------------------------------------------------------------------

export const raciToolConfig = {
  title: 'RACI matrix',
  description:
    "Read a project's RACI matrix (tickets x members, cells = R/A/C/I). `milestone` scopes to one milestone; `epicsOnly` narrows rows to epics. Returns the same data the matrix view + CSV/PDF export use. Empty when the project hasn't enabled RACI.",
  inputSchema: z.object({
    projectKey: z.string().min(1).describe('Project key (e.g. "ORB").'),
    milestone: z.string().optional().describe('Milestone name to scope the matrix.'),
    epicsOnly: z.boolean().optional().describe('Only include epics as rows.'),
  }).shape,
  annotations: { readOnlyHint: true, idempotentHint: true },
};

interface MatrixRow {
  ticketId: string;
  ticketKey: string | null;
  title: string;
  cells: Record<string, Role>;
}
interface MatrixResponse {
  raciEnabled: boolean;
  members: Array<{ userId: string; fullName: string; email: string }>;
  rows: MatrixRow[];
}

export function makeRaciHandler(client: OrbotoClient) {
  return async (input: { projectKey: string; milestone?: string; epicsOnly?: boolean }): Promise<CallToolResult> => {
    const project = await resolveProjectByKey(client, input.projectKey);

    const qs = new URLSearchParams();
    if (input.milestone) {
      const milestones = await client.get<Array<{ id: string; name: string }>>(`/projects/${project.id}/milestones`);
      const m = milestones.find((x) => x.name === input.milestone);
      if (!m) throw new Error(`Milestone "${input.milestone}" not found in project ${project.key}.`);
      qs.set('milestoneId', m.id);
    }
    if (input.epicsOnly) qs.set('epicsOnly', 'true');

    const data = await client.get<MatrixResponse>(`/projects/${project.id}/raci-matrix${qs.toString() ? `?${qs}` : ''}`);

    if (!data.raciEnabled) {
      return {
        content: [{ type: 'text', text: `RACI is not enabled for ${project.key}. Turn it on in Project Settings.` }],
        structuredContent: { raciEnabled: false, projectKey: project.key, members: [], rows: [] },
      };
    }

    // Compact text rendering: one line per ticket listing each held role.
    const lines = data.rows.map((r) => {
      const byUser = new Map(data.members.map((m) => [m.userId, m.fullName] as const));
      const held = Object.entries(r.cells)
        .map(([uid, role]) => `${role}:${byUser.get(uid) ?? uid}`)
        .join(', ');
      return `[${r.ticketKey ?? '?'}] ${r.title}${held ? ` - ${held}` : ''}`;
    });
    const text = lines.length ? lines.join('\n') : 'No tickets match the filters.';

    return {
      content: [{ type: 'text', text: `RACI matrix for ${project.key}:\n${text}` }],
      structuredContent: { raciEnabled: true, projectKey: project.key, members: data.members, rows: data.rows },
    };
  };
}

// ---------------------------------------------------------------------------
// orboto_set_raci — write a role
// ---------------------------------------------------------------------------

export const setRaciToolConfig = {
  title: 'Set a RACI role',
  description:
    "Set a person's RACI role on a ticket: R (Responsible), A (Accountable, max one per ticket), C (Consulted), or I (Informed). Resolves the user by email within the ticket's project. Requires the project to have RACI enabled and the caller to have ticket:edit. Setting a second Accountable is rejected with the name of the current one.",
  inputSchema: z.object({
    ticketKey: z.string().min(3).describe('Ticket key (e.g. "ORB-42").'),
    userEmail: z.string().email().describe('Email of a project member.'),
    role: z.enum(ROLES).describe('R, A, C, or I.'),
  }).shape,
};

export function makeSetRaciHandler(client: OrbotoClient) {
  return async ({ ticketKey, userEmail, role }: { ticketKey: string; userEmail: string; role: Role }): Promise<CallToolResult> => {
    const ticket = await resolveTicketByKey(client, ticketKey);
    const userId = await resolveMemberId(client, ticket.projectId, userEmail);
    try {
      await client.put(`/projects/${ticket.projectId}/tickets/${ticket.id}/raci/${userId}`, { role });
    } catch (err) {
      if (err instanceof OrbotoApiError && err.status === 409) {
        // Single-A violation or RACI-not-enabled — surface the clean message
        // the API put in the response body.
        let msg = err.body;
        try { msg = (JSON.parse(err.body) as { error?: string }).error ?? err.body; } catch { /* keep raw */ }
        return {
          content: [{ type: 'text', text: `Could not set ${role} on [${ticket.ticketKey}]: ${msg}` }],
          structuredContent: { error: 'conflict', ticketKey: ticket.ticketKey, message: msg },
        };
      }
      throw err;
    }
    return {
      content: [{ type: 'text', text: `Set ${userEmail} as ${role} on [${ticket.ticketKey}].` }],
      structuredContent: { ticketKey: ticket.ticketKey, userEmail, role },
    };
  };
}
