import { z } from 'zod';
const WorkSessionResourceClaimSchema = z.object({
  kind: z.enum(['path', 'named']), value: z.string().min(1).max(500), mode: z.enum(['read', 'write']),
  state: z.enum(['granted', 'waiting']).optional(), requestedAt: z.string().optional(),
});

export const AgentInventoryEntrySchema = z.object({
  userId: z.string().uuid(),
  userEmail: z.string(),
  userFullName: z.string().nullable(),
  isBot: z.boolean(),
  owner: z.object({ id: z.string().uuid(), name: z.string().nullable(), email: z.string() }).nullable(),
  autonomyPaused: z.boolean(),
  sessionId: z.string().uuid(),
  status: z.string(),
  lane: z.object({ id: z.string().uuid(), name: z.string(), role: z.string(), paused: z.boolean() }).nullable(),
  workingOnTicket: z.object({ id: z.string().uuid(), key: z.string().nullable(), title: z.string(), projectKey: z.string().nullable() }).nullable(),
  workSessions: z.array(z.object({
    ticketId: z.string().uuid(), ticketKey: z.string().nullable(), role: z.string(), leaseUntil: z.string(),
    resourceClaims: z.array(WorkSessionResourceClaimSchema),
  })),
  capabilities: z.array(z.string()),
  clientInfo: z.record(z.string(), z.string()),
  lastSeenAt: z.string(),
  createdAt: z.string(),
});

export const AgentInventorySchema = z.array(AgentInventoryEntrySchema);
export type AgentInventoryEntry = z.infer<typeof AgentInventoryEntrySchema>;
