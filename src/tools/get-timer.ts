/**
 * ORB-244 Phase B - `orboto_get_timer`.
 */
import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { OrbotoClient } from '../orboto-client.js';
import { resolveTicketByKey } from './shared.js';

/** Matches ActiveTimerSchema in @orboto/shared-schema. */
interface ActiveTimer {
  id: string;
  userId: string;
  ticketId: string;
  startedAt: string;
  pausedAt: string | null;
  accumulatedSeconds: number;
  description: string | null;
  ticketTitle?: string;
  projectId?: string;
  /** ORB-2137 - the row was matched by the single-active-timer fallback because this instance's lane was empty. */
  laneFallback?: boolean;
  agentSessionId?: string | null;
  /** ORB-2550 - who runs the timer and in which agent session. */
  userEmail?: string | null;
  userFullName?: string | null;
  agentSessionLabel?: string | null;
  /** ORB-3102 - on a read without a ticket: how many timers the session runs, when it is more than one. */
  leaseTimers?: number;
}

export const getTimerToolConfig = {
  title: 'Get current timer',
  description:
    'Return your running stopwatch, or null. The lane is resolved from this session\'s instance token, so a timer started by `orboto_claim` / `orboto_timer_start` in the same checkout reads back; `laneFallback: true` means it was matched as the account\'s only running one because this instance\'s lane was empty. Names who runs it and its agent session; the fallback never takes the timer of a session another harness process owns (409 `errors.time.timer_of_other_session` on stop). ticketKey: your timer on that ticket; a session runs one claim timer per ticket, `leaseTimers` counts them.',
  inputSchema: z.object({ ticketKey: z.string().optional() }).shape,
  annotations: { readOnlyHint: true, idempotentHint: true },
};

export function makeGetTimerHandler(client: OrbotoClient) {
  return async ({ ticketKey }: { ticketKey?: string } = {}): Promise<CallToolResult> => {
    const ticketId = ticketKey ? (await resolveTicketByKey(client, ticketKey)).id : undefined;
    const timer = await client.get<ActiveTimer | null>(ticketId ? `/time/timer?ticketId=${ticketId}` : '/time/timer');
    if (!timer) {
      return {
        content: [{ type: 'text', text: 'No active timer.' }],
        structuredContent: { timer: null },
      };
    }

    const isPaused = timer.pausedAt !== null;
    const elapsedSinceStart = isPaused
      ? 0
      : Math.floor((Date.now() - new Date(timer.startedAt).getTime()) / 1000);
    const totalSeconds = timer.accumulatedSeconds + elapsedSinceStart;
    const minutes = Math.floor(totalSeconds / 60);

    const ticketLabel = timer.ticketTitle ?? `(ticket ${timer.ticketId.slice(0, 8)})`;
    const text = [
      `Timer ${isPaused ? 'paused' : 'running'} on ${ticketLabel}`,
      `Elapsed: ${minutes} min (${totalSeconds}s total)`,
      `Started: ${timer.startedAt}`,
      `Owner: ${timer.userFullName ?? timer.userEmail ?? timer.userId}${timer.agentSessionLabel ? `, session ${timer.agentSessionLabel}` : ', no agent session'}`,
      isPaused ? `Paused: ${timer.pausedAt}` : null,
      timer.laneFallback ? 'Matched via the single-active-timer fallback - another instance started it.' : null,
      timer.leaseTimers ? `This session runs ${timer.leaseTimers} claim timers; pass ticketKey to read one.` : null,
      timer.description ? `Note: ${timer.description}` : null,
    ].filter((l): l is string => l !== null).join('\n');

    return {
      content: [{ type: 'text', text }],
      structuredContent: {
        timer: {
          ticketId: timer.ticketId,
          ticketTitle: timer.ticketTitle ?? null,
          projectId: timer.projectId ?? null,
          description: timer.description,
          startedAt: timer.startedAt,
          pausedAt: timer.pausedAt,
          accumulatedSeconds: timer.accumulatedSeconds,
          totalSeconds,
          paused: isPaused,
          laneFallback: timer.laneFallback === true,
          leaseTimers: timer.leaseTimers ?? null,
          userId: timer.userId,
          userEmail: timer.userEmail ?? null,
          agentSessionId: timer.agentSessionId ?? null,
          agentSessionLabel: timer.agentSessionLabel ?? null,
        },
      },
    };
  };
}
