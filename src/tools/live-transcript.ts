/**
 * ORB-2338 - a live session's transcript for an agent: the ORB-2242 lines
 * and the structured conversation (prompts, assistant markdown, tool groups,
 * turn ends, usage, context) as compact lines in the transcript resource.
 */
import type { OrbotoClient } from '../orboto-client.js';

/** Mirrors LIVE_TRANSCRIPT_EVENT_KINDS of @orboto/shared-schema; the MCP package ships without it, apps/api/src/test/agent-live-mcp-drift.test.ts pins the copy. */
export const LIVE_KINDS = [
  'text', 'tool_call', 'tool_result', 'question', 'permission_prompt', 'limit_prompt', 'login', 'status',
  'user_prompt', 'assistant_text', 'tool_group', 'turn_end', 'usage', 'context',
] as const;

interface ToolItem { toolUseId: string; name: string; kind: string; summary: string; isError?: boolean; durationMs?: number }
interface UsageWindow { window: string; usedPercent: number; resetsAt?: string }

/** One stored line's event, the shape GET /agents/live-sessions/:id/transcript serves. */
export type LiveEvent =
  | { kind: 'text'; role: string; text: string }
  | { kind: 'tool_call'; toolUseId: string; name: string; input: string }
  | { kind: 'tool_result'; toolUseId: string; isError: boolean; text: string }
  | { kind: 'question'; questionId: string; text: string }
  | { kind: 'permission_prompt'; questionId: string; tool: string; text: string }
  | { kind: 'limit_prompt'; questionId: string; text: string; resetsAt?: string }
  | { kind: 'login'; questionId: string; harness: string; url: string }
  | { kind: 'status'; state: string; detail?: string; model?: string }
  | { kind: 'user_prompt'; text: string; promptId?: string }
  | { kind: 'assistant_text'; text: string; messageId?: string }
  | { kind: 'tool_group'; groupId: string; final: boolean; counts: Array<{ kind: string; count: number }>; durationMs: number; items: ToolItem[]; omittedItems?: number }
  | { kind: 'turn_end'; durationMs: number; model?: string; effort?: string; outcome: string }
  | { kind: 'usage'; windows: UsageWindow[] }
  | { kind: 'context'; percent: number; tokens?: number; windowSize?: number };

export interface LiveLine { id: string; sessionId: string; seq: number; at: string; maskedCount: number; event: LiveEvent }
interface LivePage { items: LiveLine[]; nextCursor: string | null; lastSeq: number }

/** The cut one rendered line keeps; the full line stays in structuredContent. */
export const LIVE_LINE_CHARS = 600;

const USAGE_LABEL: Record<string, string> = { five_hour: '5h', seven_day: 'weekly', spend_limit: 'spend', other: 'other' };

const TOOL_VERBS: Record<string, [string, string]> = {
  read: ['read 1 file', 'read {n} files'],
  edit: ['edited 1 file', 'edited {n} files'],
  search: ['ran 1 search', 'ran {n} searches'],
  shell: ['ran 1 shell command', 'ran {n} shell commands'],
  orboto: ['called orboto once', 'called orboto {n} times'],
  web: ['fetched 1 web page', 'fetched {n} web pages'],
  agent: ['started 1 agent', 'started {n} agents'],
  mcp: ['called 1 MCP tool', 'called {n} MCP tools'],
  other: ['used 1 other tool', 'used {n} other tools'],
};

function seconds(ms: number): string {
  const total = Math.floor(ms / 1000);
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  return minutes < 60 ? `${minutes}m ${total % 60}s` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function cut(text: string, limit = LIVE_LINE_CHARS): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > limit ? `${flat.slice(0, limit)} [cut, ${flat.length - limit} more chars in structuredContent]` : flat;
}

/** One line of the transcript as text an agent reads. */
export function renderLiveEvent(event: LiveEvent): string {
  switch (event.kind) {
    case 'text': return `${event.role}: ${cut(event.text)}`;
    case 'tool_call': return `-> ${event.name} ${cut(event.input, 200)}`;
    case 'tool_result': return `<- ${event.isError ? 'error' : 'ok'}: ${cut(event.text, 200)}`;
    case 'question': return `? ${cut(event.text)}`;
    case 'permission_prompt': return `! permission ${event.tool}: ${cut(event.text)}`;
    case 'limit_prompt': return `limit: ${cut(event.text)}${event.resetsAt ? ` (resets ${event.resetsAt})` : ''}`;
    case 'login': return `login (${event.harness}): ${event.url}`;
    case 'status': return `[${event.state}${event.detail ? `: ${cut(event.detail, 200)}` : ''}${event.model ? `, ${event.model}` : ''}]`;
    case 'user_prompt': return `> ${cut(event.text)}`;
    case 'assistant_text': return `assistant: ${cut(event.text)}`;
    case 'tool_group': {
      const counts = event.counts.map((c) => (TOOL_VERBS[c.kind] ?? TOOL_VERBS.other)[c.count === 1 ? 0 : 1].replace('{n}', String(c.count))).join(', ') || 'no tool calls';
      const items = event.items.slice(0, 8).map((item) => `\n    ${item.name} ${cut(item.summary, 160)}${item.isError ? ' [error]' : ''}`).join('');
      const more = event.items.length > 8 || (event.omittedItems ?? 0) > 0 ? `\n    (+${event.items.length - Math.min(8, event.items.length) + (event.omittedItems ?? 0)} more calls)` : '';
      return `* ${counts} (${seconds(event.durationMs)}${event.final ? '' : ', running'})${items}${more}`;
    }
    case 'turn_end': return `-- turn ${event.outcome} after ${seconds(event.durationMs)}${event.model ? `, ${event.model}` : ''}${event.effort ? ` (${event.effort})` : ''}`;
    case 'usage': return `[usage: ${event.windows.map((w) => `${USAGE_LABEL[w.window] ?? w.window} ${Math.round(w.usedPercent)}%${w.resetsAt ? ` (resets ${w.resetsAt})` : ''}`).join(', ')}]`;
    case 'context': return `[context ${Math.round(event.percent)}%${event.tokens !== undefined && event.windowSize !== undefined ? `, ${event.tokens} of ${event.windowSize} tokens` : ''}]`;
  }
}

/** The lines of a page without the running tool group snapshots a later line of the same group replaces. */
export function latestLines(items: LiveLine[]): LiveLine[] {
  return items.filter((line, index) => line.event.kind !== 'tool_group' || line.event.final
    || !items.slice(index + 1).some((later) => later.event.kind === 'tool_group' && later.event.groupId === (line.event as { groupId: string }).groupId));
}

export function renderTranscriptLines(items: LiveLine[]): string[] {
  return latestLines(items).map((line) => `${line.seq} ${line.at} ${renderLiveEvent(line.event)}`);
}

/** The resource answer's cap; it runs outside the tool budget, so it cuts itself, explicitly. */
export const LIVE_RESOURCE_CHARS = 4000;

/** The newest lines that fit the resource cap, oldest first, with an explicit note of what was left out. */
export function renderTranscriptResource(sessionId: string, page: { items: LiveLine[]; lastSeq: number }): string {
  const sorted = [...page.items].sort((a, b) => a.seq - b.seq);
  const lines = renderTranscriptLines(sorted);
  const head = `# Live session ${sessionId}\n_lastSeq ${page.lastSeq}; newest lines, masked._\n`;
  const kept: string[] = [];
  let size = head.length;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (size + lines[index].length + 1 > LIVE_RESOURCE_CHARS - 200) break;
    kept.unshift(lines[index]);
    size += lines[index].length + 1;
  }
  const omitted = lines.length - kept.length;
  const note = omitted > 0 || (sorted[0]?.seq ?? 1) > 1
    ? `\n[truncated: earlier lines are not shown here - page the rest with orboto_api_call get /agents/live-sessions/${sessionId}/transcript?afterSeq=N${omitted > 0 ? `; ${omitted} of the newest ${lines.length} did not fit` : ''}]`
    : '';
  return `${head}\n${kept.length ? kept.join('\n') : '_No lines yet._'}${note}`;
}

export async function readTranscriptResource(client: OrbotoClient, sessionId: string): Promise<string> {
  const page = await client.get<LivePage>(`/agents/live-sessions/${encodeURIComponent(sessionId)}/transcript?order=desc&limit=60`);
  return renderTranscriptResource(sessionId, page);
}
