/**
 * ORB-244 Phase B — doc tools.
 *
 * `orbit_list_doc_spaces` and `orbit_get_doc` share this file for the
 * same reason the milestone tools do — cheap neighbours on the same
 * API root. Docs are referenced by UUID even in the MCP surface
 * because they have no human-readable key (no per-space short-id).
 */
import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { OrbitClient } from '../orbit-client.js';

interface DocSpaceRow {
  id: string;
  name: string;
  description: string | null;
  projectId: string | null;
  projectName: string | null;
}
interface DocRow {
  id: string;
  spaceId: string;
  title: string;
  body: string | null;
  parentDocId: string | null;
  visibility: string;
  icon: string | null;
  updatedAt: string;
}
interface DocBacklink {
  sourceId: string;
  sourceType: 'doc' | 'ticket' | 'milestone';
  sourceTitle: string | null;
}

// ---------------------------------------------------------------------------
// orbit_list_doc_spaces
// ---------------------------------------------------------------------------

export const listDocSpacesToolConfig = {
  title: 'List doc spaces',
  description:
    'List wiki spaces (global and project-scoped) the caller can read. Each space contains a tree of docs accessed via orbit_get_doc.',
  inputSchema: z.object({}).shape,
  annotations: { readOnlyHint: true, idempotentHint: true },
};

export function makeListDocSpacesHandler(client: OrbitClient) {
  return async (): Promise<CallToolResult> => {
    const spaces = await client.get<DocSpaceRow[]>('/spaces');
    const text = spaces.length === 0
      ? 'No doc spaces visible to this user.'
      : spaces.map((s) => {
        const scope = s.projectName ? `project ${s.projectName}` : 'workspace-wide';
        return `- ${s.name} (${scope}) — id: ${s.id}`;
      }).join('\n');
    return {
      content: [{ type: 'text', text }],
      structuredContent: {
        spaces: spaces.map((s) => ({
          id: s.id,
          name: s.name,
          description: s.description,
          projectName: s.projectName,
        })),
      },
    };
  };
}

// ---------------------------------------------------------------------------
// orbit_get_doc
// ---------------------------------------------------------------------------

export const getDocToolConfig = {
  title: 'Get a doc by id',
  description:
    'Return the doc body (Markdown) plus backlinks (other docs, tickets, milestones that reference this doc).',
  inputSchema: z.object({
    docId: z.string().uuid().describe('Doc UUID. Discover via orbit_list_doc_spaces or orbit_search.'),
  }).shape,
  annotations: { readOnlyHint: true, idempotentHint: true },
};

export function makeGetDocHandler(client: OrbitClient) {
  return async ({ docId }: { docId: string }): Promise<CallToolResult> => {
    const [doc, backlinks] = await Promise.all([
      client.get<DocRow>(`/docs/${docId}`),
      client.get<DocBacklink[]>(`/docs/${docId}/backlinks`).catch(() => [] as DocBacklink[]),
    ]);

    const lines = [
      `# ${doc.icon ? `${doc.icon} ` : ''}${doc.title}`,
      `Visibility: ${doc.visibility}  ·  Updated: ${doc.updatedAt}`,
      '',
      doc.body ?? '_(empty)_',
    ];

    if (backlinks.length > 0) {
      lines.push('', `## Backlinks (${backlinks.length})`);
      for (const b of backlinks) {
        lines.push(`- [${b.sourceType}] ${b.sourceTitle ?? b.sourceId.slice(0, 8)}`);
      }
    }

    return {
      content: [{ type: 'text', text: lines.join('\n') }],
      structuredContent: {
        doc: {
          id: doc.id,
          title: doc.title,
          body: doc.body,
          visibility: doc.visibility,
          icon: doc.icon,
          updatedAt: doc.updatedAt,
          parentDocId: doc.parentDocId,
          spaceId: doc.spaceId,
        },
        backlinks,
      },
    };
  };
}
