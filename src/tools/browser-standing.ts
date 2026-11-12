/** ORB-3048 - `orboto_browser_standing_allows`: list the standing allows of a browser session and ask the running session to revoke one or all. */
import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { OrbotoApiError, type OrbotoClient } from '../orboto-client.js';

/** Mirrors BrowserStandingIdSchema, BrowserStandingStepSchema and BrowserStandingDurationSchema of the shared schema; browser-standing.test.ts pins them. */
export const STANDING_ID_PATTERN = /^[a-z0-9]{6,32}$/;
export const STANDING_STEPS = ['click', 'enter', 'submit'] as const;
export const STANDING_DURATIONS = ['15m', '1h', '8h', 'session'] as const;

interface StandingAllow {
  id: string;
  host: string;
  step: (typeof STANDING_STEPS)[number];
  target: string;
  duration: (typeof STANDING_DURATIONS)[number];
  until: string | null;
  createdAt: string;
  revokeRequestedAt: string | null;
}

export const browserStandingToolConfig = {
  title: 'Browser standing allows',
  description:
    'List or revoke the standing allows of a browser session: a held irreversible step the person answered with Always allow in the orboto side panel (15m, 1h, 8h or until the session ends), so the same host, step and target run without a prompt. Only the person creates one, in the side panel; nothing here creates or extends one. revoke asks the running session through the instance (allowId, or all), it applies within a minute and the next such step asks again. The session\'s account or admin:agents:write; list also admin:system:read.',
  inputSchema: z.object({
    action: z.enum(['list', 'revoke']).optional(),
    sessionId: z.guid(),
    allowId: z.string().regex(STANDING_ID_PATTERN).optional(),
    all: z.boolean().optional(),
  }).shape,
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
};

type Args = { action?: 'list' | 'revoke'; sessionId: string; allowId?: string; all?: boolean };

function ends(allow: StandingAllow): string {
  return allow.until ? `until ${allow.until}` : 'until the session ends';
}

function line(allow: StandingAllow): string {
  return `${allow.id} ${allow.step} ${allow.target} on ${allow.host}, ${ends(allow)}${allow.revokeRequestedAt ? `, revoke requested ${allow.revokeRequestedAt}` : ''}`;
}

function refused(err: unknown): never {
  if (err instanceof OrbotoApiError && err.status === 404) {
    throw new Error(err.body.includes('browser_standing_not_found')
      ? 'The session lists no standing allow with that id: it ended, ran out or was revoked. action list shows the active ones.'
      : 'Not found: the browser session does not exist, or it is another account\'s and you lack admin:agents:write (revoke) or admin:system:read (list).');
  }
  throw err as Error;
}

export function makeBrowserStandingHandler(client: OrbotoClient) {
  return async (args: Args): Promise<CallToolResult> => {
    const action = args.action ?? 'list';
    if (action === 'revoke') {
      if (Boolean(args.allowId) === Boolean(args.all)) throw new Error('revoke needs allowId (action list shows the ids) or all: true, not both.');
      const page = await (args.allowId
        ? client.delete<{ items: StandingAllow[] }>(`/agents/browser-sessions/${args.sessionId}/standing-allows/${args.allowId}`)
        : client.delete<{ items: StandingAllow[] }>(`/agents/browser-sessions/${args.sessionId}/standing-allows`)).catch(refused);
      const text = `Asked the running session to revoke ${args.allowId ?? 'every standing allow'}: its CLI applies it at its next heartbeat (within a minute), journals it and reports it back; the next such step asks the person again.${page.items.length ? `\n${page.items.map(line).join('\n')}` : ''}`;
      return { content: [{ type: 'text', text }], structuredContent: { action, items: page.items } };
    }
    const page = await client.get<{ items: StandingAllow[] }>(`/agents/browser-sessions/${args.sessionId}/standing-allows`).catch(refused);
    const text = page.items.length
      ? page.items.map(line).join('\n')
      : 'No standing allow. Only the person creates one: Always allow on a held step in the orboto side panel.';
    return { content: [{ type: 'text', text }], structuredContent: { action, items: page.items } };
  };
}
