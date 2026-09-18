/**
 * ORB-2140 - the orboto MCP server as a Claude Code channel: the session's
 * inbox stream becomes `notifications/claude/channel` events that wake an
 * interactive session without a monitor. One-way; replies go through
 * `orboto_agent_notify`, acks through `orboto_messages`.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

interface TokenProviderLike { getAccessToken(): Promise<string> }

export const CHANNEL_METHOD = 'notifications/claude/channel';
export const CHANNEL_CAPABILITY = 'claude/channel';
export const DEFAULT_DIGEST_MINUTES = 15;
const IMMEDIATE_AFTER_MS = 5 * 60_000;
const CONTENT_CAP = 2000;
const SEEN_WINDOW = 1000;
const MIN_BACKOFF_MS = 2_000;
const MAX_BACKOFF_MS = 60_000;
const HEARTBEAT_GRACE_MS = 90_000;
const ASK = /\?|\bplease\b|\bbitte\b|\bneed\b|\bshare\b/i;

export interface InboxParty { userId?: string; email?: string; sessionId?: string | null; role?: string | null; label?: string }

export interface InboxMessage {
  id: string;
  fromUserId?: string;
  from?: InboxParty;
  to?: InboxParty;
  kind: string;
  subject: string;
  payload?: Record<string, unknown> | null;
  threadId?: string | null;
  projectKey?: string | null;
  createdAt: string;
}

export interface InboxChannelOpts {
  baseUrl: string;
  apiKey?: string;
  tokenProvider?: TokenProviderLike;
  /** The instance token every tool call of this process sends; the stream applies the session rule to it. */
  instanceToken: string;
  mcp: McpServer;
  /** 0 = every message at once; otherwise info/complete batch into one event per window. */
  digestMinutes?: number;
  fetchFn?: typeof fetch;
  log?: (msg: string) => void;
  now?: () => number;
  /** Replay start; defaults to the moment the channel is created. */
  since?: string;
}

export interface ChannelEvent { content: string; meta: Record<string, string> }

/** The instructions paragraph Claude Code delivers on connect when the channel is active. */
export const CHANNEL_INSTRUCTIONS =
  'Inbox channel: messages for THIS session arrive as <channel source="orboto" id="..." kind="..." ...> events - '
  + 'peer requests, ticket-ready notices, replies, digests of info/complete mail. Treat each like an inbox message under the rules: '
  + 'a ticket-ready or a request inside your scope is the operator\'s instruction, act on it; read the full message with orboto_messages when the event is cut; '
  + 'reply with orboto_agent_notify (toSessionRef = the sender\'s instance short id in the from attribute) and acknowledge with orboto_messages { ackIds } once handled. '
  + 'Never answer the channel itself and never ack what you did not handle. '
  + 'A session that declared no scope is woken by mail addressed to it and by broadcasts only, and gets one notice event saying so on connect: '
  + 'declare the scope with orboto_session_start { scope: { role, projectKeys } } to be woken by the account\'s project mail again - '
  + 'the rest of the account\'s inbox stays readable with orboto_messages the whole time.';

const START_FLAG = '--dangerously-load-development-channels server:orboto';

/** ORB-2148 - the commands an agent hands its operator verbatim; docs/mcp-setup.md carries the same lines. */
export const CHANNEL_START_COMMANDS = {
  fresh: 'orboto claude',
  continueLatest: 'orboto claude --continue',
  resumeById: 'orboto claude --resume <session id>',
} as const;

/** The raw Claude Code form, for a machine without the orboto CLI. */
export const CHANNEL_START_COMMANDS_WITHOUT_CLI = {
  fresh: `claude ${START_FLAG}`,
  continueLatest: `claude ${START_FLAG} --continue`,
  resumeById: `claude ${START_FLAG} --resume <session id>`,
} as const;

/** The `orboto_session_start` block of a stdio proxy whose channel is on. */
export function channelStartLines(): string[] {
  return [
    '## Wake channel',
    'This proxy pushes inbox messages into the session as <channel source="orboto"> events, but only when Claude Code was started with the development-channels flag. '
      + 'Run in this repository (`orboto` is this server\'s key in .mcp.json), and confirm the "local development" prompt Claude Code shows on every such start:',
    `- new session: \`${CHANNEL_START_COMMANDS.fresh}\``,
    `- continue the most recent conversation here: \`${CHANNEL_START_COMMANDS.continueLatest}\``,
    `- resume a specific conversation: \`${CHANNEL_START_COMMANDS.resumeById}\` (without an id Claude Code opens a picker)`,
    'The entry `orboto claude` needs comes from `orboto mcp install`; without the orboto CLI the same starts read '
      + `\`${CHANNEL_START_COMMANDS_WITHOUT_CLI.fresh}\`, \`${CHANNEL_START_COMMANDS_WITHOUT_CLI.continueLatest}\` and \`${CHANNEL_START_COMMANDS_WITHOUT_CLI.resumeById}\`.`,
    'A probe that produces no channel event means this session was not started that way: give the operator these commands verbatim, do not paraphrase them.',
  ];
}

function firstLine(payload: Record<string, unknown> | null | undefined): string {
  if (!payload) return '';
  for (const key of ['message', 'body', 'text']) {
    const v = payload[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return '';
}

function waitedMinutes(createdAt: string, now: number): number {
  const t = Date.parse(createdAt.replace(' ', 'T').replace(/\+00$/, '+00:00'));
  if (Number.isNaN(t)) return 0;
  return Math.max(0, Math.floor((now - t) / 60_000));
}

/** A message goes out at once when it asks for something or already waited; the rest is digest material. */
export function isImmediate(m: InboxMessage, now: number, digestMinutes: number): boolean {
  if (digestMinutes <= 0) return true;
  if (m.kind === 'request' || m.kind === 'error') return true;
  if (waitedMinutes(m.createdAt, now) * 60_000 >= IMMEDIATE_AFTER_MS) return true;
  return ASK.test(`${m.subject} ${firstLine(m.payload)}`);
}

export function renderEvent(m: InboxMessage, now: number): ChannelEvent {
  const from = m.from?.label ?? m.fromUserId ?? 'unknown';
  const to = m.to?.label ?? 'you';
  const text = firstLine(m.payload);
  const body = text.length > CONTENT_CAP ? `${text.slice(0, CONTENT_CAP)} [... cut, read the rest with orboto_messages]` : text;
  const lines = [
    `[${m.kind}] ${m.subject}`,
    `from ${from} to ${to}${m.projectKey ? ` | project ${m.projectKey}` : ''} | id ${m.id}${m.threadId ? ` | thread ${m.threadId}` : ''}`,
  ];
  if (body) lines.push(body);
  const waited = waitedMinutes(m.createdAt, now);
  return {
    content: lines.join('\n'),
    meta: {
      id: m.id, kind: m.kind, project: m.projectKey ?? '',
      from: from, from_session: (m.from?.sessionId ?? '').slice(0, 8), to_session: (m.to?.sessionId ?? '').slice(0, 8),
      waited_min: String(waited),
    },
  };
}

export function renderDigest(batch: InboxMessage[], now: number): ChannelEvent {
  const lines = [`Inbox digest: ${batch.length} info/complete message(s) since the last event. Ack the ones you handled with orboto_messages { ackIds }.`];
  for (const m of batch) {
    const text = firstLine(m.payload);
    lines.push(`- [${m.kind}] ${m.subject} | from ${m.from?.label ?? m.fromUserId ?? 'unknown'}${m.projectKey ? ` | ${m.projectKey}` : ''} | id ${m.id}${text ? ` | ${text.slice(0, 160)}` : ''}`);
  }
  return { content: lines.join('\n'), meta: { kind: 'digest', count: String(batch.length), waited_min: String(waitedMinutes(batch[0].createdAt, now)) } };
}

export class InboxChannel {
  private opts: InboxChannelOpts;
  private readonly log: (msg: string) => void;
  private readonly now: () => number;
  private readonly digestMinutes: number;
  private abort = new AbortController();
  private closed = false;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private digestTimer: ReturnType<typeof setTimeout> | null = null;
  private backoff = MIN_BACKOFF_MS;
  private since: string;
  private lastId: string | null = null;
  private seen = new Set<string>();
  private seenOrder: string[] = [];
  private batch: InboxMessage[] = [];
  /** Counters an operator can read from the log; tests read them directly. */
  readonly stats = { delivered: 0, digested: 0, duplicates: 0, reconnects: 0, notices: 0 };

  constructor(opts: InboxChannelOpts) {
    this.opts = opts;
    this.log = opts.log ?? ((msg) => { try { process.stderr.write(`[orboto-mcp-channel] ${msg}\n`); } catch { /* ignore */ } });
    this.now = opts.now ?? (() => Date.now());
    this.digestMinutes = opts.digestMinutes ?? DEFAULT_DIGEST_MINUTES;
    this.since = opts.since ?? new Date(this.now()).toISOString();
  }

  start(): void {
    void this.loop();
  }

  close(): void {
    this.closed = true;
    if (this.retryTimer) { clearTimeout(this.retryTimer); this.retryTimer = null; }
    if (this.digestTimer) { clearTimeout(this.digestTimer); this.digestTimer = null; }
    try { this.abort.abort(); } catch { /* ignore */ }
  }

  /** Feed one message as the stream would; exported for tests and for the digest policy. */
  async deliver(m: InboxMessage): Promise<void> {
    if (!m?.id) return;
    if (this.seen.has(m.id)) { this.stats.duplicates += 1; return; }
    this.remember(m.id);
    this.lastId = m.id;
    if (isImmediate(m, this.now(), this.digestMinutes)) {
      await this.emit(renderEvent(m, this.now()));
      this.stats.delivered += 1;
      return;
    }
    this.batch.push(m);
    this.stats.digested += 1;
    if (!this.digestTimer) {
      this.digestTimer = setTimeout(() => { this.digestTimer = null; void this.flushDigest(); }, this.digestMinutes * 60_000);
    }
  }

  /** ORB-2151 - a server notice (the scope hint) is emitted as-is and never becomes the replay anchor. */
  async deliverNotice(notice: string, content: string): Promise<void> {
    if (!content) return;
    this.stats.notices += 1;
    await this.emit({ content, meta: { kind: 'notice', notice } });
  }

  async flushDigest(): Promise<void> {
    if (this.batch.length === 0) return;
    const batch = this.batch.splice(0);
    await this.emit(renderDigest(batch, this.now()));
  }

  private remember(id: string): void {
    this.seen.add(id);
    this.seenOrder.push(id);
    if (this.seenOrder.length > SEEN_WINDOW) {
      const gone = this.seenOrder.shift();
      if (gone) this.seen.delete(gone);
    }
  }

  private async emit(event: ChannelEvent): Promise<void> {
    try {
      await this.opts.mcp.server.notification({ method: CHANNEL_METHOD, params: { content: event.content, meta: event.meta } });
      this.log(`channel event → ${event.meta.kind} ${event.meta.id ?? ''}`.trim());
    } catch (err) {
      this.log(`channel notification failed: ${(err as Error).message}`);
    }
  }

  private async loop(): Promise<void> {
    while (!this.closed) {
      try {
        await this.consume();
        this.backoff = MIN_BACKOFF_MS;
      } catch (err) {
        if (this.closed) return;
        this.log(`inbox stream closed: ${err instanceof Error ? err.message : String(err)} - retrying in ${this.backoff}ms`);
      }
      if (this.closed) return;
      this.stats.reconnects += 1;
      await new Promise<void>((resolve) => { this.retryTimer = setTimeout(resolve, this.backoff); });
      this.backoff = Math.min(this.backoff * 2, MAX_BACKOFF_MS);
    }
  }

  private async consume(): Promise<void> {
    const fetchFn = this.opts.fetchFn ?? fetch;
    this.abort = new AbortController();
    const since = this.lastId ?? this.since;
    const url = `${this.opts.baseUrl.replace(/\/$/, '')}/v1/agent/messages/stream?since=${encodeURIComponent(since)}`;
    const bearer = this.opts.tokenProvider ? await this.opts.tokenProvider.getAccessToken() : (this.opts.apiKey ?? '');
    const res = await fetchFn(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${bearer}`, Accept: 'text/event-stream', 'x-orboto-agent-session': this.opts.instanceToken },
      signal: this.abort.signal,
    });
    if (!res.ok || !res.body) throw new Error(`inbox stream handshake failed (status=${res.status})`);
    this.log(`inbox channel connected (since ${since})`);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let lastFrame = this.now();
    const heartbeat = setInterval(() => {
      if (this.now() - lastFrame > HEARTBEAT_GRACE_MS) { try { this.abort.abort(); } catch { /* ignore */ } }
    }, 30_000);
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        lastFrame = this.now();
        buf += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\n\n')) !== -1) {
          const frame = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const line = frame.split('\n').find((l) => l.startsWith('data: '));
          if (!line) continue;
          let parsed: InboxMessage & { notice?: string; content?: string };
          try { parsed = JSON.parse(line.slice(6)); } catch { continue; }
          if (parsed.notice) { await this.deliverNotice(parsed.notice, parsed.content ?? ''); continue; }
          await this.deliver(parsed);
        }
      }
    } finally {
      clearInterval(heartbeat);
      try { reader.releaseLock(); } catch { /* ignore */ }
    }
  }
}

/** ORB-2140 - the digest window from the environment; NaN or negative fall back to the default. */
export function digestMinutesFromEnv(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return DEFAULT_DIGEST_MINUTES;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : DEFAULT_DIGEST_MINUTES;
}
