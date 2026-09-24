/** ORB-2223 - the completion check: what this session still owes before its turn may end, and the explicit pause. */
import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { OrbotoClient } from '../orboto-client.js';

interface Unfinished {
  sessionId: string;
  verdict: 'continue' | 'may_stop';
  reason: string;
  text: string;
}

interface PauseState {
  sessionId: string;
  pause: { pausedAt: string; reason: string } | null;
}

export const sessionCheckToolConfig = {
  title: 'Completion check',
  description: 'Before a turn ends: what this session still owes. verdict continue or may_stop, text says why; it lists, never re-runs. pause with a reason, then resume.',
  inputSchema: z.object({
    action: z.enum(['check', 'pause', 'resume']).default('check'),
    reason: z.string().min(3).max(500).optional(),
  }).shape,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
};

export function makeSessionCheckHandler(client: OrbotoClient) {
  return async (args: { action?: 'check' | 'pause' | 'resume'; reason?: string }): Promise<CallToolResult> => {
    const action = args.action ?? 'check';
    if (action === 'pause' && !args.reason) {
      return { isError: true, content: [{ type: 'text', text: 'action pause needs a reason: why the session stops on purpose.' }] };
    }
    if (action !== 'check') {
      const res = await client.post<PauseState>(`/agents/session/${action}`, action === 'pause' ? { reason: args.reason } : {});
      const text = res.pause ? `Paused since ${res.pause.pausedAt}: ${res.pause.reason}` : 'Not paused - the completion check holds runnable work again.';
      return { content: [{ type: 'text', text }], structuredContent: res as unknown as Record<string, unknown> };
    }
    const res = await client.get<Unfinished>('/agents/session/unfinished');
    return { content: [{ type: 'text', text: res.text }], structuredContent: res as unknown as Record<string, unknown> };
  };
}
