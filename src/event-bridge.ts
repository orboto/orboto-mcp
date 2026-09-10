/**
 * ORB-940 - bridge that streams API-side events into MCP
 * `notifications/resources/updated` pushes.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { OAuthTokenProviderLike } from './orboto-client.js';

const HEARTBEAT_GRACE_MS = 90_000;
const OVERFLOW_THRESHOLD = 100;
const RECONNECT_DELAY_MS = 2_000;

/** Raw event shape from the API SSE - mirrors `WSEvent` minus the
 *  discriminated-union sharpness because we cross a JSON boundary. */
interface BridgeEvent {
  type: string;
  projectId?: string;
  ticketId?: string;
  docId?: string;
  userId?: string;
  payload?: { id?: string; ticketKey?: string; isPrivate?: boolean; statusCategory?: string } | null;
}

export interface EventBridgeOpts {
  baseUrl: string;
  /** Static bearer (an `orb_*` service-account PAT). Mutually exclusive with
   *  `tokenProvider`. */
  apiKey?: string;
  /** ORB-1470 - resolves the CURRENT bearer on every SSE (re)connect. A session
   *  whose client rotated its short-lived OAuth access token then reconnects
   *  the stream with the fresh token instead of the one pinned at session
   *  creation. When set, it takes precedence over `apiKey`. */
  tokenProvider?: OAuthTokenProviderLike;
  mcp: McpServer;
  subscriptions: Set<string>;
  /** Optional fetch override for tests. */
  fetchFn?: typeof fetch;
  /** Optional logger override. The bridge logs to stderr by default
   *  so stdout stays clean for any MCP transport that uses it. */
  log?: (msg: string) => void;
}

/** Map a raw event to the set of `orboto://` URIs that should be
 *  notified. Returns an empty array for events that don't map to any
 *  subscribed resource shape (no-op). */
export function eventToUris(event: BridgeEvent): string[] {
  if (event.type === 'ticket:created' || event.type === 'ticket:updated' || event.type === 'ticket:deleted'
   || event.type === 'ticket:activity'
   || event.type === 'comment:created' || event.type === 'comment:updated' || event.type === 'comment:deleted'
   || event.type === 'checklist:created' || event.type === 'checklist:updated' || event.type === 'checklist:deleted'
   || event.type === 'checklist-item:created' || event.type === 'checklist-item:updated' || event.type === 'checklist-item:deleted') {
    const uris: string[] = [];
    const key = event.payload?.ticketKey;
    if (key) uris.push(`orboto://ticket/${key}`);
    if (event.projectId) uris.push(`orboto://project/${event.projectId}`);
    if (event.type === 'ticket:updated' && key && event.payload?.statusCategory === 'done') {
      uris.push(`orboto://handoff/closed/${key}`);
    }
    return uris;
  }

  if (event.type === 'project:bulk-activity' || event.type === 'member:joined' || event.type === 'member:removed') {
    return event.projectId ? [`orboto://project/${event.projectId}`] : [];
  }

  if (event.type === 'ticket:ready') {
    return event.projectId ? [`orboto://ready/${event.projectId}`] : [];
  }

  if (event.type === 'agent_escalation:raised') {
    return event.projectId ? [`orboto://escalation/${event.projectId}`] : [];
  }

  if (event.type === 'doc:updated') {
    return event.docId ? [`orboto://doc/${event.docId}`] : [];
  }

  if (event.type === 'timer:changed') {
    return [`orboto://timer`];
  }

  if (event.type === 'agent_broadcast:posted') {
    const p = (event as { payload?: { scopeType?: string; scopeId?: string } }).payload;
    if (p?.scopeType) {
      const scopeId = p.scopeId ?? '';
      return [`orboto://broadcast/${p.scopeType}/${scopeId}`];
    }
    return [];
  }

  if (event.type === 'agent_quorum:opened' || event.type === 'agent_quorum:approved') {
    const p = (event as { payload?: { topicKey?: string } }).payload;
    return p?.topicKey ? [`orboto://quorum/${p.topicKey}`] : [];
  }

  if (event.type === 'notification:new') {
    return [`orboto://user/me/notifications`];
  }

  return [];
}

export class EventBridge {
  private opts: EventBridgeOpts;
  private abort = new AbortController();
  private overflow = 0;
  private closed = false;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private log: (msg: string) => void;

  constructor(opts: EventBridgeOpts) {
    this.opts = opts;
    this.log = opts.log ?? ((msg) => { try { process.stderr.write(`[orboto-mcp-bridge] ${msg}\n`); } catch { /* ignore */ } });
  }

  /** Open the SSE stream and start forwarding. Resolves immediately;
   *  the actual forwarding happens on the returned background loop. */
  start(): void {
    void this.loop();
  }

  /** Stop the bridge. Safe to call multiple times. */
  close(): void {
    this.closed = true;
    if (this.retryTimer) { clearTimeout(this.retryTimer); this.retryTimer = null; }
    try { this.abort.abort(); } catch { /* ignore */ }
  }

  private async loop(): Promise<void> {
    while (!this.closed) {
      try {
        await this.consume();
      } catch (err) {
        if (this.closed) return;
        const reason = err instanceof Error ? err.message : String(err);
        this.log(`stream closed: ${reason} - retrying in ${RECONNECT_DELAY_MS}ms`);
      }
      if (this.closed) return;
      await new Promise<void>((resolve) => {
        this.retryTimer = setTimeout(resolve, RECONNECT_DELAY_MS);
      });
    }
  }

  private async consume(): Promise<void> {
    const fetchFn = this.opts.fetchFn ?? fetch;
    this.abort = new AbortController();
    const url = `${this.opts.baseUrl.replace(/\/$/, '')}/sse/mcp-events`;
    const bearer = this.opts.tokenProvider
      ? await this.opts.tokenProvider.getAccessToken()
      : (this.opts.apiKey ?? '');
    const res = await fetchFn(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${bearer}`,
        Accept: 'text/event-stream',
      },
      signal: this.abort.signal,
    });
    if (!res.ok || !res.body) {
      throw new Error(`SSE bridge handshake failed (status=${res.status})`);
    }

    this.log(`SSE bridge connected → ${url}`);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let lastFrame = Date.now();
    const heartbeat = setInterval(() => {
      if (Date.now() - lastFrame > HEARTBEAT_GRACE_MS) {
        try { this.abort.abort(); } catch { /* ignore */ }
      }
    }, 30_000);

    try {
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        lastFrame = Date.now();
        buf += decoder.decode(value, { stream: true });
        let idx;
        // eslint-disable-next-line no-cond-assign
        while ((idx = buf.indexOf('\n\n')) !== -1) {
          const frame = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const line = frame.split('\n').find((l) => l.startsWith('data: '));
          if (!line) continue;
          const json = line.slice(6);
          let event: BridgeEvent;
          try { event = JSON.parse(json); } catch { continue; }
          await this.dispatch(event);
        }
      }
    } finally {
      clearInterval(heartbeat);
      try { reader.releaseLock(); } catch { /* ignore */ }
    }
  }

  private async dispatch(event: BridgeEvent): Promise<void> {
    const uris = eventToUris(event);
    if (uris.length === 0) return;
    const matched: string[] = [];
    for (const uri of uris) {
      if (this.opts.subscriptions.has(uri)) matched.push(uri);
    }
    if (matched.length === 0) return;

    if (this.overflow >= OVERFLOW_THRESHOLD) {
      try {
        await this.opts.mcp.server.sendResourceListChanged();
      } catch (err) {
        this.log(`sendResourceListChanged failed: ${(err as Error).message}`);
      }
      this.overflow = 0;
      return;
    }

    for (const uri of matched) {
      try {
        await this.opts.mcp.server.sendResourceUpdated({ uri });
        this.log(`pushed resources/updated → ${uri} (event=${event.type})`);
        this.overflow += 1;
      } catch (err) {
        this.log(`sendResourceUpdated(${uri}) failed: ${(err as Error).message}`);
      }
    }
  }
}
