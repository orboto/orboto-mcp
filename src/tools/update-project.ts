/**
 * ORB-885 - `orboto_update_project`.
 * ORB-830 - `orboto_create_project` + `orboto_archive_project`.
 *
 * @see ORB-244
 */
import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { OrbotoClient } from '../orboto-client.js';
import { resolveProjectByKey, type ProjectRow } from './shared.js';

const PROJECT_KEY_RE = /^[A-Z0-9]+$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LOCALE_CODES = ['en', 'de', 'fr', 'es', 'it', 'nl', 'pt', 'ru', 'pl', 'tr', 'cs', 'da', 'sv', 'no', 'fi', 'ja', 'zh', 'ko'] as const;
type LocaleCode = (typeof LOCALE_CODES)[number];

export const updateProjectToolConfig = {
  title: 'Update a project\'s metadata',
  description:
    'Patch a project (`name`, `description`, `key`, `status`, `branchTemplate`, `customerId`, `language`). At least one field must be set. Use `status: "archived"` or `"closed"` to take a project out of active rotation. Renaming the `key` also rewrites every ticket\'s `PROJ-N` reference - handle with care. `language` sets the project\'s expected ticket language (one of the 18 supported locales); pass null to inherit the workspace language.',
  inputSchema: z.object({
    projectKey: z.string().min(1).describe('Current project key (e.g. "ACME"). Case-insensitive.'),
    patch: z.object({
      name: z.string().min(1).max(255).optional(),
      description: z.string().nullable().optional().describe('Pass null to clear the description.'),
      key: z.string().min(2).max(10).regex(PROJECT_KEY_RE).optional()
        .describe('New project key. A-Z0-9 only, 2-10 chars. Rewrites every ticket reference.'),
      status: z.enum(['draft', 'active', 'archived', 'closed']).optional(),
      branchTemplate: z.string().max(100).nullable().optional(),
      customerId: z.string().regex(UUID_RE).nullable().optional()
        .describe('UUID of a customer record, or null to detach.'),
      language: z.enum(LOCALE_CODES).nullable().optional()
        .describe('Project content language (ORB-994). Wins over the workspace language for this project. null = inherit workspace.'),
    }).refine((p) => Object.keys(p).length > 0, { message: 'patch must include at least one field' }),
  }).shape,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
};

export function makeUpdateProjectHandler(client: OrbotoClient) {
  return async ({ projectKey, patch }: {
    projectKey: string;
    patch: {
      name?: string;
      description?: string | null;
      key?: string;
      status?: 'draft' | 'active' | 'archived' | 'closed';
      branchTemplate?: string | null;
      customerId?: string | null;
      language?: LocaleCode | null;
    };
  }): Promise<CallToolResult> => {
    const project = await resolveProjectByKey(client, projectKey);
    const updated = await client.patch<ProjectRow>(`/projects/${project.id}`, patch);
    const fields = Object.keys(patch).join(', ');
    return {
      content: [{
        type: 'text',
        text: `Updated project ${updated.key} - ${updated.name} (${fields}).`,
      }],
      structuredContent: {
        id: updated.id,
        key: updated.key,
        name: updated.name,
        description: updated.description,
        status: updated.status,
        language: updated.language ?? null,
      },
    };
  };
}

export const createProjectToolConfig = {
  title: 'Create a new project',
  description:
    'Create a new project in the workspace. `name` is required; `key` is optional and the API auto-derives one from the name when omitted (uppercase initials). Returns the new project\'s id + key + status (`active` by default). Caller must have `admin:project:create` or be a super-admin. Note: a new project is auto-provisioned with a general doc space (slug `<key>-general`, system-generated, for the AI primer + notes) - don\'t create a separate doc space for its docs, reuse that one (orboto_list_doc_spaces).',
  inputSchema: z.object({
    name: z.string().min(1).max(255).describe('Display name for the project.'),
    key: z.string().min(2).max(10).regex(PROJECT_KEY_RE).optional()
      .describe('Optional explicit key (e.g. "ACME"). A-Z0-9 only, 2-10 chars. Auto-derived from name when omitted.'),
    description: z.string().nullable().optional().describe('Optional free-text description.'),
    customerId: z.string().regex(UUID_RE).nullable().optional()
      .describe('Optional UUID of a customer record to attach the project to.'),
    language: z.enum(LOCALE_CODES).nullable().optional()
      .describe('Optional project content language (ORB-994), one of the 18 supported locales. Omit/null = inherit the workspace language.'),
  }).shape,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
};

export function makeCreateProjectHandler(client: OrbotoClient) {
  return async ({ name, key, description, customerId, language }: {
    name: string;
    key?: string;
    description?: string | null;
    customerId?: string | null;
    language?: LocaleCode | null;
  }): Promise<CallToolResult> => {
    const body: Record<string, unknown> = { name };
    if (key !== undefined) body.key = key;
    if (description !== undefined) body.description = description;
    if (customerId !== undefined) body.customerId = customerId;
    if (language !== undefined) body.language = language;
    const created = await client.post<ProjectRow>('/projects', body);
    return {
      content: [{
        type: 'text',
        text: `Created project ${created.key} - ${created.name} (status: ${created.status}).`,
      }],
      structuredContent: {
        id: created.id,
        key: created.key,
        name: created.name,
        description: created.description,
        status: created.status,
        language: created.language ?? null,
      },
    };
  };
}

export const archiveProjectToolConfig = {
  title: 'Archive a project',
  description:
    'Archive a project - moves it out of the active rotation without deleting any data. Convenience wrapper around `orboto_update_project({ status: "archived" })` because "archive this project" is a workflow operators hit often. Archiving is reversible: pass the same project back through `orboto_update_project({ status: "active" })` to restore. Idempotent - re-archiving an already-archived project is a no-op success.',
  inputSchema: z.object({
    projectKey: z.string().min(1).describe('Project key (e.g. "ACME") of the project to archive.'),
  }).shape,
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
};

export function makeArchiveProjectHandler(client: OrbotoClient) {
  return async ({ projectKey }: { projectKey: string }): Promise<CallToolResult> => {
    const project = await resolveProjectByKey(client, projectKey);
    if (project.status === 'archived') {
      return {
        content: [{
          type: 'text',
          text: `Project ${project.key} is already archived (no-op).`,
        }],
        structuredContent: {
          id: project.id,
          key: project.key,
          name: project.name,
          description: project.description,
          status: project.status,
          alreadyArchived: true,
        },
      };
    }
    const updated = await client.patch<ProjectRow>(`/projects/${project.id}`, { status: 'archived' });
    return {
      content: [{
        type: 'text',
        text: `Archived project ${updated.key} - ${updated.name}.`,
      }],
      structuredContent: {
        id: updated.id,
        key: updated.key,
        name: updated.name,
        description: updated.description,
        status: updated.status,
        alreadyArchived: false,
      },
    };
  };
}
