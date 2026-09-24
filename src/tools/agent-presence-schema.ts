import { z } from 'zod';
import { AgentSessionScopeSchema } from './agent-session-scope.js';
const WorkSessionResourceClaimSchema = z.object({
  kind: z.enum(['path', 'named']), value: z.string().min(1).max(500), mode: z.enum(['read', 'write']),
  state: z.enum(['granted', 'waiting']).optional(), requestedAt: z.string().optional(), grantedAt: z.string().optional(),
});

/** ORB-2209 - one account reference, shared by `actsAs` and `owner`. */
const AgentAccountRefSchema = z.object({ id: z.string().uuid(), name: z.string().nullable(), email: z.string() });

export const AgentInventoryKindSchema = z.enum(['agent', 'human']);
export const AgentConnectionTypeSchema = z.enum(['api_key', 'oauth', 'lane', 'external_token', 'live_events', 'web', 'channel']);
export const AgentInventoryConnectionSchema = z.object({ type: AgentConnectionTypeSchema, label: z.string() });
export const AgentInventoryProjectSchema = z.object({ id: z.string().uuid(), key: z.string(), name: z.string() });

export const AgentInventoryEntrySchema = z.object({
  userId: z.string().uuid(),
  userEmail: z.string(),
  userFullName: z.string().nullable(),
  kind: AgentInventoryKindSchema,
  /** Alias of `kind === 'agent'`. */
  isBot: z.boolean(),
  actsAs: AgentAccountRefSchema.nullable(),
  owner: AgentAccountRefSchema.nullable(),
  autonomyPaused: z.boolean(),
  sessionId: z.string().uuid(),
  status: z.string(),
  lane: z.object({ id: z.string().uuid(), name: z.string(), role: z.string(), paused: z.boolean() }).nullable(),
  projects: z.array(AgentInventoryProjectSchema),
  connections: z.array(AgentInventoryConnectionSchema),
  workingOnTicket: z.object({ id: z.string().uuid(), key: z.string().nullable(), title: z.string(), projectKey: z.string().nullable() }).nullable(),
  workSessions: z.array(z.object({
    ticketId: z.string().uuid(), ticketKey: z.string().nullable(), role: z.string(), leaseUntil: z.string(),
    resourceClaims: z.array(WorkSessionResourceClaimSchema),
  })),
  capabilities: z.array(z.string()),
  clientInfo: z.record(z.string(), z.string()),
  /** ORB-2136 - the scope the session declared; null when it declared none. */
  scope: AgentSessionScopeSchema.nullable(),
  /** ORB-2136 - unread inbox messages this session would list. */
  unreadMessages: z.number().int(),
  /**
   * ORB-2149 - the last 24 hours of wakes: how many deliveries, how precise,
   * what the wrong ones cost. ORB-2170 - `backlogSeen` is the `nudge` count
   * over the same window, a backlog sighting rather than a wake.
   */
  wakes: z.object({
    count: z.number().int(),
    precision: z.number().nullable(),
    wrongWakeContextTokens: z.number().int(),
    backlogSeen: z.number().int(),
  }),
  /** ORB-2181 - a restart was requested for this session and its supervisor has not reconnected yet. */
  restartPending: z.boolean(),
  /** ORB-2181 - the reason the requester gave; null when nothing is pending. */
  restartReason: z.string().nullable(),
  /** ORB-2189 - the answering instance holds this session's live wake channel, so a restart request can reach it. */
  restartable: z.boolean(),
  /** ORB-2209 - stream reconnects this row survived; the id and the scope stayed the same. */
  reconnects: z.number().int(),
  lastReconnectAt: z.string().nullable(),
  lastSeenAt: z.string(),
  createdAt: z.string(),
});

export const AgentInventorySchema = z.array(AgentInventoryEntrySchema);
export type AgentInventoryEntry = z.infer<typeof AgentInventoryEntrySchema>;
export type AgentInventoryConnection = z.infer<typeof AgentInventoryConnectionSchema>;
export type AgentConnectionType = z.infer<typeof AgentConnectionTypeSchema>;
