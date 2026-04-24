/**
 * ORB-244 Phase B — `orbit_get_project`.
 *
 * Returns metadata + milestones + labels for a project. Accepts the
 * human-readable project key (`ACME`), case-insensitive — the API's
 * `GET /projects/by-key/:key` does the lookup, the rest of the
 * hydration (milestones + labels) comes from the `/projects/:id/*`
 * endpoints that take the resolved UUID.
 *
 * The reason we don't just expose a key on the inner endpoints too:
 * every other ticket / milestone / label route is UUID-keyed for
 * join-performance, and one new endpoint per shape would be a lot
 * of surface for a niche MCP concern.
 */
import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { OrbitClient } from '../orbit-client.js';
import { resolveProjectByKey } from './shared.js';

interface MilestoneRow {
  id: string;
  name: string;
  status: string;
  startDate: string | null;
  endDate: string | null;
}
interface LabelRow { id: string; name: string; color: string | null }
interface MemberRow {
  userId: string;
  fullName: string;
  email: string;
  roleName: string;
}

export const getProjectToolConfig = {
  title: 'Get project details',
  description:
    'Return a single project with its milestones, labels, and members. Input is the project key like "ACME" (case-insensitive).',
  inputSchema: z.object({
    projectKey: z.string().min(1).describe('Project key (e.g. "ACME"). Case-insensitive.'),
  }).shape,
  annotations: { readOnlyHint: true, idempotentHint: true },
};

export function makeGetProjectHandler(client: OrbitClient) {
  return async ({ projectKey }: { projectKey: string }): Promise<CallToolResult> => {
    const project = await resolveProjectByKey(client, projectKey);
    // Parallel fan-out — the API doesn't have a single aggregate route
    // for milestones+labels+members, and three parallel fetches beat a
    // chain on the default Node HTTP pool.
    const [milestones, labels, members] = await Promise.all([
      client.get<MilestoneRow[]>(`/projects/${project.id}/milestones`),
      client.get<LabelRow[]>(`/projects/${project.id}/labels`),
      client.get<MemberRow[]>(`/projects/${project.id}/members`),
    ]);

    const lines = [
      `Project ${project.key} — ${project.name} (${project.status})`,
      project.description ? `Description: ${project.description}` : null,
      '',
      `Milestones (${milestones.length}):`,
      ...milestones.map((m) => `  - ${m.name} [${m.status}]${m.endDate ? ` due ${m.endDate}` : ''}`),
      '',
      `Labels: ${labels.map((l) => l.name).join(', ') || '(none)'}`,
      '',
      `Members (${members.length}):`,
      ...members.map((m) => `  - ${m.fullName || m.email} <${m.email}> — ${m.roleName}`),
    ].filter((l): l is string => l !== null);

    return {
      content: [{ type: 'text', text: lines.join('\n') }],
      structuredContent: {
        project: {
          key: project.key,
          name: project.name,
          status: project.status,
          description: project.description,
        },
        milestones,
        labels,
        members,
      },
    };
  };
}
