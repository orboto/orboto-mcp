/**
 * ORB-244 Phase B — `orbit_get_timer`.
 *
 * Returns the caller's active stopwatch (or `null` when none is
 * running). Useful for the model to answer "am I still tracking
 * time on that bug from earlier?" without guessing.
 */
import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { OrbitClient } from '../orbit-client.js';

interface TimerRow {
  id: string;
  ticketId: string;
  ticketKey: string | null;
  ticketTitle: string | null;
  startedAt: string;
  pausedAt: string | null;
  accumulatedSeconds: number;
}

export const getTimerToolConfig = {
  title: 'Get current timer',
  description:
    'Return the caller\'s currently-running stopwatch (or null if no timer is active).',
  inputSchema: z.object({}).shape,
  annotations: { readOnlyHint: true },
};

export function makeGetTimerHandler(client: OrbitClient) {
  return async (): Promise<CallToolResult> => {
    // The `/time/timer` endpoint returns { timer: TimerRow | null }.
    const res = await client.get<{ timer: TimerRow | null }>('/time/timer');
    const timer = res.timer;
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

    const text = [
      `Timer ${isPaused ? 'paused' : 'running'} on [${timer.ticketKey ?? timer.ticketId.slice(0, 8)}] ${timer.ticketTitle ?? ''}`,
      `Elapsed: ${minutes} min (${totalSeconds}s total)`,
      `Started: ${timer.startedAt}`,
      isPaused ? `Paused: ${timer.pausedAt}` : null,
    ].filter((l): l is string => l !== null).join('\n');

    return {
      content: [{ type: 'text', text }],
      structuredContent: {
        timer: {
          ticketKey: timer.ticketKey,
          ticketTitle: timer.ticketTitle,
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
