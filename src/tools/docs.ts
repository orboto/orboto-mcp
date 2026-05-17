/**
 * ORB-244 Phase B — doc tools.
 *
 * `orboto_list_doc_spaces` and `orboto_get_doc` share this file for the
 * same reason the milestone tools do — cheap neighbours on the same
 * API root. Docs are referenced by UUID even in the MCP surface
 * because they have no human-readable key (no per-space short-id).
 *
 * ORB-912 (epic ORB-911) added the write-path neighbours so an
 * MCP-aware client can do the full space lifecycle without falling
 * back to REST: create / update / delete spaces, list docs in a
 * space, and (in follow-up phases) write / move / attach / export /
 * roll back individual doc pages.
 *
 * Schema alignment: field names match `@orboto/shared-schema`
 * exactly — `content` not `body` on docs, `excerpt` not `snippet` on
 * hits, backlinks carry `{type, id, label, sourceDocId,
 * sourceDocTitle, sourceSpaceId}`. Getting those wrong 500s the tool
 * because the API's Zod response validator rejects off-shape rows
 * before they leave the server.
 */
import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { OrbotoClient } from '../orboto-client.js';

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
// orboto_list_doc_spaces
// ---------------------------------------------------------------------------

export const listDocSpacesToolConfig = {
  title: 'List doc spaces',
  description:
    'List wiki spaces (global and project-scoped) the caller can read. Each space contains a tree of docs accessed via orboto_get_doc.',
  inputSchema: z.object({}).shape,
  annotations: { readOnlyHint: true, idempotentHint: true },
};

export function makeListDocSpacesHandler(client: OrbotoClient) {
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
// orboto_get_doc
// ---------------------------------------------------------------------------

export const getDocToolConfig = {
  title: 'Get a doc by id',
  description:
    'Return the doc content (Markdown) plus backlinks (other docs that reference this doc, or tickets/milestones the doc is linked from).',
  inputSchema: z.object({
    docId: z.string().uuid().describe('Doc UUID. Discover via orboto_list_doc_spaces or orboto_search.'),
  }).shape,
  annotations: { readOnlyHint: true, idempotentHint: true },
};

export function makeGetDocHandler(client: OrbotoClient) {
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

// ---------------------------------------------------------------------------
// orboto_create_doc_space  (ORB-912)
// ---------------------------------------------------------------------------

export const createDocSpaceToolConfig = {
  title: 'Create a doc space',
  description:
    'Create a new wiki space. `type=global` creates a workspace-wide space (super-admin only); `type=project` requires `projectId` and creates a space scoped to that project. The slug is derived from `name` when omitted. Returns the new space row.',
  inputSchema: z.object({
    name: z.string().min(1).max(100).describe('Display name.'),
    type: z.enum(['global', 'project']).describe('Scope: workspace-wide or project-scoped.'),
    projectId: z.string().uuid().optional().describe('Required when type=project.'),
    description: z.string().nullish(),
    icon: z.string().nullish().describe('Single emoji (e.g. "📘") used in the sidebar tree.'),
    slug: z.string().min(1).max(100).regex(/^[a-z0-9-]+$/).optional().describe('URL slug. Auto-derived from name when omitted.'),
  }).shape,
};

export function makeCreateDocSpaceHandler(client: OrbotoClient) {
  return async (input: {
    name: string; type: 'global' | 'project'; projectId?: string;
    description?: string | null; icon?: string | null; slug?: string;
  }): Promise<CallToolResult> => {
    const body: Record<string, unknown> = { name: input.name, type: input.type };
    if (input.projectId) body.projectId = input.projectId;
    if (input.description !== undefined) body.description = input.description;
    if (input.icon !== undefined) body.icon = input.icon;
    if (input.slug) body.slug = input.slug;
    const row = await client.post<DocSpaceRow>('/spaces', body);
    return {
      content: [{ type: 'text', text: `Created doc space: ${row.name}\n  id: ${row.id}\n  type: ${row.type}\n  slug: ${row.slug}` }],
      structuredContent: {
        id: row.id,
        name: row.name,
        slug: row.slug,
        type: row.type,
        projectId: row.projectId,
        isPublic: row.isPublic,
      },
    };
  };
}

// ---------------------------------------------------------------------------
// orboto_update_doc_space  (ORB-912)
// ---------------------------------------------------------------------------

export const updateDocSpaceToolConfig = {
  title: 'Update a doc space',
  description:
    'Patch a space\'s name / description / icon / isPublic / slug. `type` and `projectId` are immutable. Auto-generated project primer spaces (`isSystemGenerated: true`) refuse `name` / `slug` edits — only description / icon / isPublic stay editable on those.',
  inputSchema: z.object({
    spaceId: z.string().uuid().describe('Space UUID (find via orboto_list_doc_spaces).'),
    name: z.string().min(1).max(100).optional(),
    description: z.string().nullish(),
    icon: z.string().nullish(),
    isPublic: z.boolean().optional(),
    slug: z.string().min(1).max(100).regex(/^[a-z0-9-]+$/).optional(),
  }).shape,
};

export function makeUpdateDocSpaceHandler(client: OrbotoClient) {
  return async (input: {
    spaceId: string; name?: string; description?: string | null;
    icon?: string | null; isPublic?: boolean; slug?: string;
  }): Promise<CallToolResult> => {
    const body: Record<string, unknown> = {};
    if (input.name !== undefined) body.name = input.name;
    if (input.description !== undefined) body.description = input.description;
    if (input.icon !== undefined) body.icon = input.icon;
    if (input.isPublic !== undefined) body.isPublic = input.isPublic;
    if (input.slug !== undefined) body.slug = input.slug;
    if (Object.keys(body).length === 0) {
      throw new Error('Pass at least one field to update.');
    }
    const row = await client.patch<DocSpaceRow>(`/spaces/${input.spaceId}`, body);
    return {
      content: [{ type: 'text', text: `Updated doc space: ${row.name}\n  id: ${row.id}` }],
      structuredContent: {
        id: row.id,
        name: row.name,
        slug: row.slug,
        type: row.type,
        projectId: row.projectId,
        isPublic: row.isPublic,
      },
    };
  };
}

// ---------------------------------------------------------------------------
// orboto_delete_doc_space  (ORB-912)
// ---------------------------------------------------------------------------

export const deleteDocSpaceToolConfig = {
  title: 'Delete a doc space',
  description:
    'DESTRUCTIVE — cascades through every doc in the space (the pages themselves are gone, not just hidden). System-generated project primer spaces refuse deletion (they cascade only when the owning project is deleted). Returns success silently; 404 surfaces as an OrbotoApiError.',
  inputSchema: z.object({
    spaceId: z.string().uuid(),
  }).shape,
  annotations: { destructiveHint: true },
};

export function makeDeleteDocSpaceHandler(client: OrbotoClient) {
  return async ({ spaceId }: { spaceId: string }): Promise<CallToolResult> => {
    await client.delete(`/spaces/${spaceId}`);
    return {
      content: [{ type: 'text', text: `Doc space ${spaceId} deleted.` }],
      structuredContent: { spaceId, deleted: true },
    };
  };
}

// ---------------------------------------------------------------------------
// orboto_list_docs_in_space  (ORB-912)
// ---------------------------------------------------------------------------

export const listDocsInSpaceToolConfig = {
  title: 'List docs inside a space',
  description:
    'Return the flat list of doc pages in a space — each carries `parentDocId` so the caller can reconstruct the tree client-side. Use this when an agent needs to find a doc by title rather than asking for a UUID first. Pair with orboto_get_doc to read individual page bodies.',
  inputSchema: z.object({
    spaceId: z.string().uuid().describe('Space UUID (find via orboto_list_doc_spaces).'),
  }).shape,
  annotations: { readOnlyHint: true, idempotentHint: true },
};

export function makeListDocsInSpaceHandler(client: OrbotoClient) {
  return async ({ spaceId }: { spaceId: string }): Promise<CallToolResult> => {
    const rows = await client.get<DocRow[]>(`/spaces/${spaceId}/docs`);
    if (rows.length === 0) {
      return {
        content: [{ type: 'text', text: 'No docs in this space.' }],
        structuredContent: { docs: [] },
      };
    }
    // Index by parent so we can render a simple indented tree. The
    // tree-walk runs in JS — the API hands us the flat list because
    // sort-order is per-parent and traversal is the caller's concern.
    const byParent = new Map<string | null, DocRow[]>();
    for (const r of rows) {
      const key = r.parentDocId ?? null;
      const arr = byParent.get(key) ?? [];
      arr.push(r);
      byParent.set(key, arr);
    }
    for (const arr of byParent.values()) {
      arr.sort((a, b) => a.sortOrder - b.sortOrder || a.title.localeCompare(b.title));
    }
    const lines: string[] = [];
    const walk = (parentId: string | null, depth: number): void => {
      const children = byParent.get(parentId) ?? [];
      for (const c of children) {
        const indent = '  '.repeat(depth);
        const iconPart = c.icon ? `${c.icon} ` : '';
        lines.push(`${indent}- ${iconPart}${c.title}  (id: ${c.id})`);
        walk(c.id, depth + 1);
      }
    };
    walk(null, 0);
    return {
      content: [{ type: 'text', text: lines.join('\n') }],
      structuredContent: {
        docs: rows.map((r) => ({
          id: r.id,
          title: r.title,
          slug: r.slug,
          parentDocId: r.parentDocId,
          visibility: r.visibility,
          icon: r.icon,
          sortOrder: r.sortOrder,
          updatedAt: r.updatedAt,
        })),
      },
    };
  };
}
