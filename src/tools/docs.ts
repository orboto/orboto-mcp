/**
 * ORB-244 Phase B — doc tools.
 *
 * `orboto_list_doc_spaces` and `orboto_get_doc` share this file for the
 * same reason the milestone tools do — cheap neighbours on the same
 * API root. Docs carry a human-readable key (`ORB-D12` / `DOC-5`,
 * ORB-1004) and spaces carry one too (`ORB-S1` / `SPACE-5`, ORB-1015);
 * both resolve by key or UUID.
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
import { resolveProjectByKey } from './shared.js';

interface DocSpaceRow {
  id: string;
  name: string;
  slug: string;
  // ORB-1015 — human-readable, typeable space key (`ORB-S1` / `SPACE-5`).
  key: string | null;
  description: string | null;
  icon: string | null;
  type: string; // 'global' | 'project' per DocSpaceTypeEnum
  projectId: string | null;
  isPublic: boolean;
  visibility?: string | null;
  guestsVisible?: boolean | null;
}
interface DocRow {
  id: string;
  spaceId: string;
  parentDocId: string | null;
  title: string;
  content: string;
  slug: string;
  // ORB-1004 — human-readable, typeable doc key (`ORB-D12` / `DOC-5`).
  docKey: string | null;
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
        // ORB-1161 — show key AND uuid. Doc tools accept the key directly,
        // but surface the uuid too for any tool that still needs it.
        return `- ${s.name} (${scope}) - key: ${s.key ?? '(none)'}  id: ${s.id}`;
      }).join('\n');
    return {
      content: [{ type: 'text', text }],
      structuredContent: {
        spaces: spaces.map((s) => ({
          id: s.id,
          name: s.name,
          slug: s.slug,
          key: s.key ?? null,
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

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ORB-1084 — every docId-taking tool accepts the human-readable doc
// key (ORB-D12 / DOC-5) as well; writes were UUID-only while no tool
// exposed the full UUID, so agents could read but never write.
export async function resolveDocId(client: OrbotoClient, docIdOrKey: string): Promise<string> {
  if (UUID_RE.test(docIdOrKey)) return docIdOrKey;
  const doc = await client.get<{ id: string }>(`/docs/by-key/${encodeURIComponent(docIdOrKey)}`);
  return doc.id;
}

export const getDocToolConfig = {
  title: 'Get a doc by id or key',
  description:
    'Return the doc content (Markdown) plus backlinks (other docs that reference this doc, or tickets/milestones the doc is linked from). Accepts either the doc UUID or its human-readable key (e.g. ORB-D12 / DOC-5).',
  inputSchema: z.object({
    docId: z.string().min(1).describe('Doc UUID or human-readable key (ORB-D12 / DOC-5). Discover via orboto_list_doc_spaces or orboto_search.'),
  }).shape,
  annotations: { readOnlyHint: true, idempotentHint: true },
};

export function makeGetDocHandler(client: OrbotoClient) {
  return async ({ docId }: { docId: string }): Promise<CallToolResult> => {
    // ORB-1004 — accept a doc key too; resolve via the by-key route, then
    // use the resolved UUID for the backlinks fetch.
    const doc = UUID_RE.test(docId)
      ? await client.get<DocRow>(`/docs/${docId}`)
      : await client.get<DocRow>(`/docs/by-key/${encodeURIComponent(docId)}`);
    const backlinks = await client.get<DocBacklinkRow[]>(`/docs/${doc.id}/backlinks`).catch(() => [] as DocBacklinkRow[]);

    const lines = [
      `# ${doc.icon ? `${doc.icon} ` : ''}${doc.title}`,
      `${doc.docKey ? `Key: ${doc.docKey}  ·  ` : ''}ID: ${doc.id}  ·  Visibility: ${doc.visibility}  ·  Updated: ${doc.updatedAt}`,
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
          docKey: doc.docKey,
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
    'Create a new wiki space. IMPORTANT: every project ALREADY has an auto-generated general space (slug `<key>-general`, system-generated, holds the AI primer + manual notes) — do NOT create a second space just to hold a project\'s docs. Call orboto_list_doc_spaces first and reuse the existing project space; only create a new one for a genuinely separate collection. `type=global` creates a workspace-wide space (super-admin only); `type=project` creates a space scoped to a project — pass `projectKey` (e.g. "ORB"); a raw `projectId` UUID is still accepted for back-compat. The slug is derived from `name` when omitted. Returns the new space row.',
  inputSchema: z.object({
    name: z.string().min(1).max(100).describe('Display name.'),
    type: z.enum(['global', 'project']).describe('Scope: workspace-wide or project-scoped.'),
    projectKey: z.string().min(1).optional().describe('Project key (e.g. "ORB"). Required when type=project (or pass projectId).'),
    projectId: z.string().uuid().optional().describe('Project UUID. Back-compat alternative to projectKey when type=project.'),
    description: z.string().nullish(),
    icon: z.string().nullish().describe('Single emoji (e.g. "📘") used in the sidebar tree.'),
    slug: z.string().min(1).max(100).regex(/^[a-z0-9-]+$/).optional().describe('URL slug. Auto-derived from name when omitted.'),
  }).shape,
};

export function makeCreateDocSpaceHandler(client: OrbotoClient) {
  return async (input: {
    name: string; type: 'global' | 'project'; projectKey?: string; projectId?: string;
    description?: string | null; icon?: string | null; slug?: string;
  }): Promise<CallToolResult> => {
    const body: Record<string, unknown> = { name: input.name, type: input.type };
    if (input.type === 'project') {
      // Prefer the key (agent-facing surfaces speak keys); fall back to a raw
      // UUID for back-compat.
      let projectId = input.projectId;
      if (!projectId && input.projectKey) {
        projectId = (await resolveProjectByKey(client, input.projectKey)).id;
      }
      if (!projectId) throw new Error('type=project requires projectKey (or a projectId UUID).');
      body.projectId = projectId;
    } else if (input.projectId) {
      body.projectId = input.projectId;
    }
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
        visibility: row.visibility ?? null,
        guestsVisible: row.guestsVisible ?? null,
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
    'Patch a space\'s name / description / icon / slug, and (ORB-1080) its visibility settings: `visibility` (workspace = every internal member, restricted = explicit allowlist via memberIds), `guestsVisible` (external users see the space only when true). Visibility fields require space-management rights (global spaces: super-admin; project spaces: project:edit) - plain membership gets a 403 for those. `isPublic` is deprecated (replaced by guestsVisible). `type` and `projectId` are immutable; auto-generated primer spaces refuse name/slug edits.',
  inputSchema: z.object({
    spaceId: z.string().uuid().describe('Space UUID (find via orboto_list_doc_spaces).'),
    name: z.string().min(1).max(100).optional(),
    description: z.string().nullish(),
    icon: z.string().nullish(),
    isPublic: z.boolean().optional().describe('DEPRECATED - use guestsVisible.'),
    visibility: z.enum(['workspace', 'project_members', 'restricted']).optional().describe('Space-level read gate: workspace = every internal member, project_members = project members whose role grants doc:view (project spaces only), restricted = standalone allowlist. Requires manage rights.'),
    guestsVisible: z.boolean().optional().describe('Explicit guest (external user) opt-in. Requires manage rights.'),
    memberIds: z.array(z.string().uuid()).optional().describe('Replaces the restricted-space allowlist. Requires manage rights.'),
    slug: z.string().min(1).max(100).regex(/^[a-z0-9-]+$/).optional(),
  }).shape,
};

export function makeUpdateDocSpaceHandler(client: OrbotoClient) {
  return async (input: {
    spaceId: string; name?: string; description?: string | null;
    icon?: string | null; isPublic?: boolean; slug?: string;
    visibility?: 'workspace' | 'restricted'; guestsVisible?: boolean; memberIds?: string[];
  }): Promise<CallToolResult> => {
    const body: Record<string, unknown> = {};
    if (input.name !== undefined) body.name = input.name;
    if (input.description !== undefined) body.description = input.description;
    if (input.icon !== undefined) body.icon = input.icon;
    if (input.isPublic !== undefined) body.isPublic = input.isPublic;
    if (input.slug !== undefined) body.slug = input.slug;
    // ORB-1080 — visibility settings (manage-gated server-side).
    if (input.visibility !== undefined) body.visibility = input.visibility;
    if (input.guestsVisible !== undefined) body.guestsVisible = input.guestsVisible;
    if (input.memberIds !== undefined) body.memberIds = input.memberIds;
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
        visibility: row.visibility ?? null,
        guestsVisible: row.guestsVisible ?? null,
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
    spaceId: z.string().min(1).describe('Space key (e.g. ORB-S1), name, or UUID. Discover via orboto_list_doc_spaces.'),
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
        // ORB-1004 — show the typeable key (falls back to UUID).
        lines.push(`${indent}- ${iconPart}${c.title}  (${c.docKey ?? c.id})`);
        walk(c.id, depth + 1);
      }
    };
    walk(null, 0);
    return {
      content: [{ type: 'text', text: lines.join('\n') }],
      structuredContent: {
        docs: rows.map((r) => ({
          id: r.id,
          docKey: r.docKey,
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

// ---------------------------------------------------------------------------
// orboto_create_doc  (ORB-913)
// ---------------------------------------------------------------------------

export const createDocToolConfig = {
  title: 'Create a doc page',
  description:
    'Create a new wiki page in `spaceId` with the supplied Markdown body. Unlike orboto_ingest_url / orboto_ingest_file (which derive content from an external source), this is the plain "I have the Markdown, make me a page" path. Title is required; content is optional (creates an empty page). Returns the new doc row including its UUID and its human-readable doc key (e.g. ORB-D12).',
  inputSchema: z.object({
    spaceId: z.string().min(1).describe('Target doc space - key (e.g. ORB-S1), name, or UUID. Discover via orboto_list_doc_spaces.'),
    title: z.string().min(1).max(255),
    content: z.string().optional().describe('Markdown body. Pass an empty string or omit for a blank page.'),
    parentDocId: z.string().uuid().nullable().optional().describe('Nest under another doc.'),
    visibility: z.enum(['public', 'workspace', 'members', 'specific']).optional().describe('Defaults to "workspace".'),
    icon: z.string().nullish().describe('Single emoji shown in the tree.'),
  }).shape,
};

export function makeCreateDocHandler(client: OrbotoClient) {
  return async (input: {
    spaceId: string; title: string; content?: string;
    parentDocId?: string | null; visibility?: 'public' | 'workspace' | 'members' | 'specific';
    icon?: string | null;
  }): Promise<CallToolResult> => {
    const body: Record<string, unknown> = { title: input.title };
    if (input.content !== undefined) body.content = input.content;
    if (input.parentDocId !== undefined) body.parentDocId = input.parentDocId;
    if (input.visibility) body.visibility = input.visibility;
    if (input.icon !== undefined) body.icon = input.icon;
    const row = await client.post<DocRow>(`/spaces/${input.spaceId}/docs`, body);
    return {
      content: [{ type: 'text', text: `Created doc: ${row.title}\n  key: ${row.docKey ?? '(none)'}\n  id: ${row.id}\n  slug: ${row.slug}\n  visibility: ${row.visibility}` }],
      structuredContent: {
        id: row.id,
        docKey: row.docKey,
        title: row.title,
        slug: row.slug,
        spaceId: row.spaceId,
        parentDocId: row.parentDocId,
        visibility: row.visibility,
      },
    };
  };
}

// ---------------------------------------------------------------------------
// orboto_update_doc  (ORB-913)
// ---------------------------------------------------------------------------

export const updateDocToolConfig = {
  title: 'Update a doc page',
  description:
    'Patch a doc\'s title / content / visibility / parent / icon. Content-only updates do not require sending the title. Every body or title change snapshots the previous version into the revision history automatically — agents can roll back via orboto_restore_doc_revision (when that tool ships in Phase 5). Re-embeds the doc when content or title change.',
  inputSchema: z.object({
    docId: z.string().min(1).describe('Doc UUID or human-readable doc key (ORB-D12 / DOC-5).'),
    title: z.string().min(1).max(255).optional(),
    content: z.string().optional().describe('Markdown body. Send the full new content; the API replaces, not appends.'),
    parentDocId: z.string().uuid().nullable().optional(),
    visibility: z.enum(['public', 'workspace', 'members', 'specific']).optional(),
    icon: z.string().nullish(),
  }).shape,
};

export function makeUpdateDocHandler(client: OrbotoClient) {
  return async (input: {
    docId: string; title?: string; content?: string;
    parentDocId?: string | null; visibility?: 'public' | 'workspace' | 'members' | 'specific';
    icon?: string | null;
  }): Promise<CallToolResult> => {
    input.docId = await resolveDocId(client, input.docId);
    const body: Record<string, unknown> = {};
    if (input.title !== undefined) body.title = input.title;
    if (input.content !== undefined) body.content = input.content;
    if (input.parentDocId !== undefined) body.parentDocId = input.parentDocId;
    if (input.visibility !== undefined) body.visibility = input.visibility;
    if (input.icon !== undefined) body.icon = input.icon;
    if (Object.keys(body).length === 0) {
      throw new Error('Pass at least one field to update.');
    }
    const row = await client.patch<DocRow>(`/docs/${input.docId}`, body);
    return {
      content: [{ type: 'text', text: `Updated doc: ${row.title}\n  id: ${row.id}\n  updatedAt: ${row.updatedAt}` }],
      structuredContent: {
        id: row.id,
        title: row.title,
        spaceId: row.spaceId,
        parentDocId: row.parentDocId,
        visibility: row.visibility,
        updatedAt: row.updatedAt,
      },
    };
  };
}

// ---------------------------------------------------------------------------
// orboto_delete_doc  (ORB-913)
// ---------------------------------------------------------------------------

export const deleteDocToolConfig = {
  title: 'Delete a doc page',
  description:
    'DESTRUCTIVE — removes the page from the tree. Revisions are NOT auto-cascaded; the API keeps them so an admin could in principle resurrect from history, but the page itself is gone from listings. System-generated primer docs refuse deletion (the regenerator re-creates them). Returns success silently; 404 is also silent (idempotent).',
  inputSchema: z.object({
    docId: z.string().min(1).describe('Doc UUID or human-readable doc key (ORB-D12 / DOC-5).'),
  }).shape,
  annotations: { destructiveHint: true },
};

export function makeDeleteDocHandler(client: OrbotoClient) {
  return async ({ docId }: { docId: string }): Promise<CallToolResult> => {
    docId = await resolveDocId(client, docId);
    await client.delete(`/docs/${docId}`);
    return {
      content: [{ type: 'text', text: `Doc ${docId} deleted.` }],
      structuredContent: { docId, deleted: true },
    };
  };
}

// ---------------------------------------------------------------------------
// orboto_move_doc  (ORB-913)
// ---------------------------------------------------------------------------

export const moveDocToolConfig = {
  title: 'Move a doc page (reparent / reorder / cross-space)',
  description:
    'Reparent a doc, change its sort order, or move it into a different space. All three target fields are optional but at least one must be supplied. Distinct from orboto_update_doc\'s parentDocId because the API endpoint emits a different WS event for the tree-rebuild path connected clients care about.',
  inputSchema: z.object({
    docId: z.string().min(1).describe('Doc UUID or human-readable doc key (ORB-D12 / DOC-5).'),
    parentDocId: z.string().uuid().nullable().optional().describe('null = top-level; UUID = nest under that doc.'),
    spaceId: z.string().uuid().optional().describe('Move into a different space. Caller must be member of both.'),
    sortOrder: z.number().int().optional(),
  }).shape,
};

export function makeMoveDocHandler(client: OrbotoClient) {
  return async (input: {
    docId: string; parentDocId?: string | null; spaceId?: string; sortOrder?: number;
  }): Promise<CallToolResult> => {
    input.docId = await resolveDocId(client, input.docId);
    const body: Record<string, unknown> = {};
    if (input.parentDocId !== undefined) body.parentDocId = input.parentDocId;
    if (input.spaceId !== undefined) body.spaceId = input.spaceId;
    if (input.sortOrder !== undefined) body.sortOrder = input.sortOrder;
    if (Object.keys(body).length === 0) {
      throw new Error('Pass at least one of parentDocId / spaceId / sortOrder.');
    }
    const row = await client.post<DocRow>(`/docs/${input.docId}/move`, body);
    return {
      content: [{ type: 'text', text: `Moved doc ${row.title}\n  spaceId: ${row.spaceId}\n  parentDocId: ${row.parentDocId ?? '(root)'}\n  sortOrder: ${row.sortOrder}` }],
      structuredContent: {
        id: row.id,
        spaceId: row.spaceId,
        parentDocId: row.parentDocId,
        sortOrder: row.sortOrder,
      },
    };
  };
}

// ---------------------------------------------------------------------------
// orboto_duplicate_doc_space  (ORB-918)
// ---------------------------------------------------------------------------

export const duplicateDocSpaceToolConfig = {
  title: 'Duplicate a doc space (clone the space + every doc inside it)',
  description:
    'Fork a doc space along with its entire doc tree. The new space\'s name becomes `<source> (copy)`, parent-child relationships in the tree are preserved via UUID remap. Useful when an agent wants to iterate on a runbook space without mutating the original.',
  inputSchema: z.object({
    spaceId: z.string().uuid().describe('Source space to duplicate.'),
  }).shape,
};

export function makeDuplicateDocSpaceHandler(client: OrbotoClient) {
  return async ({ spaceId }: { spaceId: string }): Promise<CallToolResult> => {
    const row = await client.post<DocSpaceRow>(`/spaces/${spaceId}/duplicate`, {});
    return {
      content: [{
        type: 'text',
        text: `Duplicated space ${spaceId} → ${row.name}\n  id: ${row.id}\n  slug: ${row.slug}`,
      }],
      structuredContent: {
        sourceSpaceId: spaceId,
        newSpaceId: row.id,
        name: row.name,
        slug: row.slug,
        type: row.type,
        projectId: row.projectId,
      },
    };
  };
}

// ---------------------------------------------------------------------------
// orboto_resolve_doc_smart_links  (ORB-918)
// ---------------------------------------------------------------------------

interface SmartLinkResolution {
  type: 'doc' | 'ticket' | 'milestone' | 'project' | 'commit';
  id: string;
  title: string;
  url: string;
  projectKey?: string | null;
  ticketKey?: string | null;
  commitShort?: string | null;
  commitAuthor?: string | null;
  commitProvider?: 'github' | 'gitlab' | 'azure_devops' | 'bitbucket_cloud' | 'bitbucket_server' | 'gitea' | 'ssh' | null;
}

export const resolveDocSmartLinksToolConfig = {
  title: 'Batch-resolve smart-link references to display metadata',
  description:
    'Resolve `[[doc:UUID]]` / `[[ticket:UUID]]` / `[[milestone:UUID]]` / `[[project:UUID]]` / commit-hash references to their current title + URL. Visibility-filtered — items the caller is not allowed to see come back as missing (the rendering frontend falls back to the literal label in that case). Useful when reading a doc body that contains many tokens and you want to display them with current titles in one round-trip rather than N+1 get-* calls. Max 200 items per call.',
  inputSchema: z.object({
    items: z.array(z.object({
      type: z.enum(['doc', 'ticket', 'milestone', 'project', 'commit']),
      id: z.string().min(1).max(64).describe('UUID for the entity types; full or short hex hash for commit.'),
    })).min(1).max(200),
  }).shape,
  annotations: { readOnlyHint: true, idempotentHint: true },
};

export function makeResolveDocSmartLinksHandler(client: OrbotoClient) {
  return async ({ items }: {
    items: Array<{ type: 'doc' | 'ticket' | 'milestone' | 'project' | 'commit'; id: string }>;
  }): Promise<CallToolResult> => {
    const resolved = await client.post<SmartLinkResolution[]>('/docs/resolve-links', { items });
    const resolvedKeys = new Set(resolved.map((r) => `${r.type}:${r.id}`));
    const missing = items.filter((i) => !resolvedKeys.has(`${i.type}:${i.id}`));
    const lines = resolved.map((r) => {
      const extra = r.type === 'ticket' && r.ticketKey
        ? `  [${r.ticketKey}]`
        : r.type === 'commit' && r.commitShort
          ? `  (${r.commitShort})`
          : '';
      return `- ${r.type}:${r.id}  →  ${r.title}${extra}  ·  ${r.url}`;
    });
    if (missing.length > 0) {
      lines.push('', `Unresolved (visibility or missing) — ${missing.length}:`);
      for (const m of missing) lines.push(`  - ${m.type}:${m.id}`);
    }
    return {
      content: [{ type: 'text', text: lines.join('\n') || 'No resolvable references.' }],
      structuredContent: {
        resolved: resolved.map((r) => ({
          type: r.type,
          id: r.id,
          title: r.title,
          url: r.url,
          projectKey: r.projectKey ?? null,
          ticketKey: r.ticketKey ?? null,
          commitShort: r.commitShort ?? null,
          commitAuthor: r.commitAuthor ?? null,
          commitProvider: r.commitProvider ?? null,
        })),
        unresolved: missing,
      },
    };
  };
}
