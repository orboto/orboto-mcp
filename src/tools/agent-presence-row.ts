import { z } from 'zod';
import { AgentInventoryKindSchema, AgentSessionWakeSchema } from './agent-presence-schema.js';
import { AgentSessionScopeSchema } from './agent-session-scope.js';

/** ORB-2548 - one presence row as orboto_agent_presence returns it; the full inventory row is `orboto agents --json` and `GET /v1/agent/who?include=inventory`. */
export const AgentPresenceRowSchema = z.object({
  sessionId: z.string().uuid(),
  userEmail: z.string(),
  userFullName: z.string().nullable(),
  kind: AgentInventoryKindSchema,
  owner: z.string().nullable(),
  status: z.string(),
  lane: z.string().nullable(),
  scope: AgentSessionScopeSchema.nullable(),
  memberProjects: z.number().int(),
  connections: z.array(z.string()),
  wake: AgentSessionWakeSchema.optional(),
  state: z.string().optional(),
  origin: z.object({ host: z.string().nullable(), repo: z.string().nullable(), pid: z.number().nullable(), harness: z.string().nullable(), client: z.string().nullable() }).nullable(),
  workingOn: z.string().nullable(),
  lastSeenAt: z.string(),
  redacted: z.boolean().optional(),
});
export type AgentPresenceRow = z.infer<typeof AgentPresenceRowSchema>;
