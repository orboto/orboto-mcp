import { z } from 'zod';

export const ProjectReadinessStatusSchema = z.enum(['ok', 'missing', 'n/a']);
export const ProjectReadinessItemIdSchema = z.enum(['project_record', 'human_manager', 'milestones', 'git_connection', 'doc_primer', 'instructions', 'tech_stack', 'commands', 'lane_assignment', 'acceptance', 'spec_settings', 'sentry_intake']);
const ProjectReadinessFixSchema = z.object({ method: z.string(), route: z.string(), mcpTool: z.string(), cliCommand: z.string(), settingsPath: z.string(), note: z.string().optional() });
export const ProjectReadinessItemSchema = z.object({
  id: ProjectReadinessItemIdSchema,
  status: ProjectReadinessStatusSchema,
  reason: z.string(),
  checked: z.number().int().nonnegative(),
  missing: z.number().int().nonnegative(),
  detail: z.string().optional().describe('The stored decision text behind the reason, e.g. why a project needs no headless lane.'),
  fix: ProjectReadinessFixSchema,
  alternatives: z.array(ProjectReadinessFixSchema).optional().describe('Other ways to resolve the item, offered next to fix.'),
});
export const ProjectReadinessSchema = z.object({
  projectId: z.string().uuid(), projectKey: z.string(), ready: z.boolean(), language: z.string(),
  ticketScope: z.literal('visible'),
  items: z.array(ProjectReadinessItemSchema),
});
export type ProjectReadiness = z.infer<typeof ProjectReadinessSchema>;
export type ProjectReadinessItem = z.infer<typeof ProjectReadinessItemSchema>;
