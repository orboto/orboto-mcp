import { z } from 'zod';

/** ORB-2136 - standalone mirror of `@orboto/shared-schema` agent-session-scope (the MCP package does not depend on it). */
export const AgentSessionRoleSchema = z.enum(['integrator', 'lead', 'worker', 'spec', 'review', 'coordinator']);
export const AgentSessionScopeSchema = z.object({
  projectKeys: z.array(z.string()).optional(),
  ticketKeys: z.array(z.string()).optional(),
  role: AgentSessionRoleSchema.optional(),
});
export type AgentSessionScope = z.infer<typeof AgentSessionScopeSchema>;
