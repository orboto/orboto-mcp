/**
 * ORB-244 Phase B — doc tools.
 *
 * `orbit_list_doc_spaces` and `orbit_get_doc` share this file for the
 * same reason the milestone tools do — cheap neighbours on the same
 * API root. Docs are referenced by UUID even in the MCP surface
 * because they have no human-readable key (no per-space short-id).
 *
 * Schema alignment: field names match `@orbit/shared-schema`
 * exactly — `content` not `body` on docs, `excerpt` not `snippet` on
 * hits, backlinks carry `{type, id, label, sourceDocId,
 * sourceDocTitle, sourceSpaceId}`. Getting those wrong 500s the tool
 * because the API's Zod response validator rejects off-shape rows
 * before they leave the server.
 */
import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { OrbitClient } from '../orbit-client.js';

interface DocSpaceRow {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  icon: string | null;
  type: string; // 'global' | 'project' per DocSpaceTypeEnum
  projectId: string | null;
  isPublic: boolean;
}
interface DocRow {
  id: string;
  spaceId: string;
  parentDocId: string | null;
  title: string;
  content: string;
  slug: string;
  visibility: string;
  icon: string | null;
  sortOrder: number;
  updatedAt: string;
}
interface DocBacklinkRow {
  /** `ticket` | `milestone` | `doc` per DocLinkTargetEnum. */
  type: string;
  id: string;
  label: string | null;
  sourceDocId: string;
  sourceDocTitle: string;
  sourceSpaceId: string;
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
        // `type` is the authoritative scope indicator; `projectId` is
        // populated when type === 'project'. We use the type flag so
        // the text rendering doesn't depend on an extra API join.
        const scope = s.type === 'project' ? 'project-scoped' : 'workspace-wide';
        return `- ${s.name} (${scope}) — id: ${s.id}`;
      }).join('\n');
    return {
      content: [{ type: 'text', text }],
      structuredContent: {
        spaces: spaces.map((s) => ({
          id: s.id,
          name: s.name,
          slug: s.slug,
          type: s.type,
          description: s.description,
          projectId: s.projectId,
          isPublic: s.isPublic,
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
    'Return the doc content (Markdown) plus backlinks (other docs that reference this doc, or tickets/milestones the doc is linked from).',
  inputSchema: z.object({
    docId: z.string().uuid().describe('Doc UUID. Discover via orbit_list_doc_spaces or orbit_search.'),
  }).shape,
  annotations: { readOnlyHint: true, idempotentHint: true },
};

export function makeGetDocHandler(client: OrbitClient) {
  return async ({ docId }: { docId: string }): Promise<CallToolResult> => {
    const [doc, backlinks] = await Promise.all([
      client.get<DocRow>(`/docs/${docId}`),
      client.get<DocBacklinkRow[]>(`/docs/${docId}/backlinks`).catch(() => [] as DocBacklinkRow[]),
    ]);

    const lines = [
      `# ${doc.icon ? `${doc.icon} ` : ''}${doc.title}`,
      `Visibility: ${doc.visibility}  ·  Updated: ${doc.updatedAt}`,
      '',
      doc.content || '_(empty)_',
    ];

    if (backlinks.length > 0) {
      lines.push('', `## Backlinks (${backlinks.length})`);
      for (const b of backlinks) {
        // sourceDocTitle is the doc that links *to* this one; the
        // `type` + `id` pair identifies the target — same row, target
        // side. For most backlinks the target is this doc, so we
        // surface the source.
        lines.push(`- ${b.sourceDocTitle}`);
      }
    }

    return {
      content: [{ type: 'text', text: lines.join('\n') }],
      structuredContent: {
        doc: {
          id: doc.id,
          title: doc.title,
          content: doc.content,
          visibility: doc.visibility,
          icon: doc.icon,
          updatedAt: doc.updatedAt,
          parentDocId: doc.parentDocId,
          spaceId: doc.spaceId,
          slug: doc.slug,
        },
        backlinks: backlinks.map((b) => ({
          sourceDocId: b.sourceDocId,
          sourceDocTitle: b.sourceDocTitle,
          targetType: b.type,
          label: b.label,
        })),
      },
    };
  };
}
