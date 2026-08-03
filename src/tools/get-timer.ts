/**
 * ORB-244 Phase B — `orboto_get_timer`.
 *
 * Returns the caller's active stopwatch (or `null` when none is
 * running). Useful for the model to answer "am I still tracking
 * time on that bug from earlier?" without guessing.
 *
 * API shape: `GET /time/timer` returns `ActiveTimer | null` directly
 * (not wrapped). ActiveTimer carries `ticketTitle` and `projectId`
 * as joined fields but no `ticketKey` — so the ticket identifier is
 * resolved the cheap way: first 8 chars of the UUID when no title
 * is available, just the title otherwise.
 */
import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { OrbotoClient } from '../orboto-client.js';

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
}

export const getTimerToolConfig = {
  title: 'Get current timer',
  description:
    'Return the caller\'s currently-running stopwatch (or null if no timer is active).',
  inputSchema: z.object({}).shape,
  annotations: { readOnlyHint: true, idempotentHint: true },
};

export function makeGetTimerHandler(client: OrbotoClient) {
  return async (): Promise<CallToolResult> => {
    // `/time/timer` returns the timer row directly, or `null`.
    const timer = await client.get<ActiveTimer | null>('/time/timer');
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
      isPaused ? `Paused: ${timer.pausedAt}` : null,
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
        },
      },
    };
  };
}
