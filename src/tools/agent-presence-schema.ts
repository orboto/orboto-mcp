import { z } from 'zod';
import { AgentSessionScopeSchema } from './agent-session-scope.js';
import { isoDateTime } from '../zod-v3-formats.js';

type Output<S> = S extends { _output: infer O } ? O : never;
type Input<S> = S extends { _input: infer I } ? I : never;
const typedIO = <S>(schema: S) => schema as unknown as z.ZodType<Output<S>, Input<S>>;
const WorkSessionResourceClaimSchema = z.object({
  kind: z.enum(['path', 'named']), value: z.string().min(1).max(500), mode: z.enum(['read', 'write']),
  state: z.enum(['granted', 'waiting']).optional(), requestedAt: z.string().optional(), grantedAt: z.string().optional(),
});

/** ORB-2209 - one account reference, shared by `actsAs` and `owner`. */
const AgentAccountRefSchema = z.object({ id: z.guid(), name: z.string().nullable(), email: z.string() });

export const AgentInventoryKindSchema = z.enum(['agent', 'human']);
export const AgentConnectionTypeSchema = z.enum(['api_key', 'oauth', 'lane', 'external_token', 'live_events', 'web', 'channel']);
export const AgentInventoryConnectionSchema = z.object({ type: AgentConnectionTypeSchema, label: z.string() });
/** ORB-2584 - mirror of AgentSessionWakeSchema in @orboto/shared-schema agent-session-wake.ts. */
export const AgentSessionWakeSchema = z.enum(['channel', 'stream', 'lane', 'on_call']);
export type AgentSessionWake = z.infer<typeof AgentSessionWakeSchema>;

/** ORB-2584 - mirror of AGENT_WAKE_LABELS: what presence lines print for each wake. */
export const AGENT_WAKE_LABELS: Record<AgentSessionWake, string> = {
  channel: 'reachable by channel',
  stream: 'reachable by inbox stream',
  lane: 'reachable as a lane',
  on_call: 'reads mail only on its own calls',
};
export const AgentInventoryProjectSchema = z.object({ id: z.guid(), key: z.string(), name: z.string() });

/** ORB-2769 - one verdict of the subagent limit gate a Claude Code hook took before an Agent call. */
export const AgentLimitDecisionSchema = z.object({
  at: isoDateTime({ offset: true }),
  agent: z.string().max(64).optional().describe('The subagent that asked to start another one; absent for the main session.'),
  model: z.string().max(64).optional(),
  window: z.string().max(64).optional().describe('The window that gates the model, such as `Opus weekly` or `7-day`.'),
  usedPercent: z.number().min(0).max(1000).optional(),
  threshold: z.number().min(0).max(100).optional(),
  action: z.enum(['allow', 'switch_needed', 'fallback', 'deny', 'unknown', 'no_profiles']),
  profile: z.string().max(64).optional(),
  target: z.string().max(64).optional().describe('The login profile that has room; the gate never switches a login.'),
  fallback: z.string().max(32).optional().describe('The model a Fable subagent moves to: only `opus`.'),
  resetsAt: z.string().max(40).optional(),
  waitUntil: z.string().max(40).optional().describe('ORB-3051 - the reset a window at its threshold waits for within the reset grace instead of a switch.'),
  detail: z.string().max(400).optional(),
});

/** ORB-2769 - the limit gate summary a session's heartbeat carries: the last decisions and whether auto-switch has no login profiles. */
export const AgentLimitGateSchema = z.object({
  noProfiles: z.boolean(),
  decisions: z.array(AgentLimitDecisionSchema).max(5),
});
export type AgentLimitGate = z.infer<typeof AgentLimitGateSchema>;
export type AgentLimitDecision = z.infer<typeof AgentLimitDecisionSchema>;

export const AgentInventoryEntryObjectSchema = z.object({
  userId: z.guid(),
  userEmail: z.string(),
  userFullName: z.string().nullable(),
  kind: AgentInventoryKindSchema,
  /** Alias of `kind === 'agent'`. */
  isBot: z.boolean(),
  actsAs: AgentAccountRefSchema.nullable(),
  owner: AgentAccountRefSchema.nullable(),
  autonomyPaused: z.boolean(),
  sessionId: z.guid(),
  status: z.string(),
  lane: z.object({ id: z.guid(), name: z.string(), role: z.string(), paused: z.boolean() }).nullable(),
  projects: z.array(AgentInventoryProjectSchema),
  connections: z.array(AgentInventoryConnectionSchema),
  /** ORB-2584 - whether mail wakes the session (channel, stream, lane) or it reads mail only on its own calls (`on_call`). */
  wake: AgentSessionWakeSchema.optional(),
  workingOnTicket: z.object({ id: z.guid(), key: z.string().nullable(), title: z.string(), projectKey: z.string().nullable() }).nullable(),
  workSessions: z.array(z.object({
    ticketId: z.guid(), ticketKey: z.string().nullable(), role: z.string(), leaseUntil: z.string(),
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
  /** ORB-2769 - the subagent limit gate summary the session's status line last reported; null when it reported none. */
  limitGate: AgentLimitGateSchema.nullable().optional(),
  lastSeenAt: z.string(),
  createdAt: z.string(),
});

export const AgentInventoryEntrySchema = typedIO(AgentInventoryEntryObjectSchema);

export const AgentInventorySchema = typedIO(z.array(AgentInventoryEntrySchema));
export type AgentInventoryEntry = z.infer<typeof AgentInventoryEntrySchema>;
export type AgentInventoryConnection = z.infer<typeof AgentInventoryConnectionSchema>;
export type AgentConnectionType = z.infer<typeof AgentConnectionTypeSchema>;
