import { z } from 'zod';

export const ProjectReadinessStatusSchema = z.enum(['ok', 'missing', 'n/a']);
export const ProjectReadinessItemIdSchema = z.enum(['project_record', 'human_manager', 'milestones', 'git_connection', 'doc_primer', 'instructions', 'tech_stack', 'commands', 'lane_assignment', 'acceptance', 'spec_settings', 'sentry_intake']);
export const ProjectReadinessItemSchema = z.object({
  id: ProjectReadinessItemIdSchema,
  status: ProjectReadinessStatusSchema,
  reason: z.string(),
  checked: z.number().int().nonnegative(),
  missing: z.number().int().nonnegative(),
  fix: z.object({ method: z.string(), route: z.string(), mcpTool: z.string(), cliCommand: z.string(), settingsPath: z.string() }),
});
export const ProjectReadinessSchema = z.object({
  projectId: z.string().uuid(), projectKey: z.string(), ready: z.boolean(), language: z.string(),
  ticketScope: z.literal('visible'),
  items: z.array(ProjectReadinessItemSchema),
});
export type ProjectReadiness = z.infer<typeof ProjectReadinessSchema>;
export type ProjectReadinessItem = z.infer<typeof ProjectReadinessItemSchema>;
