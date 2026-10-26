import { z } from 'zod';

/** ORB-2136 - standalone mirror of `@orboto/shared-schema` agent-session-scope (the MCP package does not depend on it). */
export const AgentSessionRoleSchema = z.enum(['integrator', 'lead', 'worker', 'spec', 'review', 'coordinator']);
export const AgentSessionScopeSchema = z.object({
  projectKeys: z.array(z.string()).max(50).optional(),
  ticketKeys: z.array(z.string()).max(200).optional(),
  role: AgentSessionRoleSchema.optional(),
});
/** ORB-2684 - the declarable scope: `account` is the explicit account view of an integrator or a coordinator. */
export const AgentSessionScopeInputSchema = AgentSessionScopeSchema.extend({ account: z.boolean().optional() });
export type AgentSessionScope = z.infer<typeof AgentSessionScopeInputSchema>;
