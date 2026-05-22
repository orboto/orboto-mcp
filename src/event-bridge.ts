/**
 * ORB-940 — bridge that streams API-side events into MCP
 * `notifications/resources/updated` pushes.
 *
 * One bridge instance per MCP session. On `start()` it opens an SSE
 * stream to `${baseUrl}/sse/mcp-events` with the session's bearer
 * token; every incoming frame is mapped to a resource URI and pushed
 * to the connected MCP client IF the client has subscribed to that
 * URI via the `resources/subscribe` flow.
 *
 * Backpressure: if more than `OVERFLOW_THRESHOLD` events are forwarded
 * since the last `notifications/resources/list_changed`, we emit a
 * single list_changed instead of every individual update and reset
 * the counter. The list_changed tells the client "your view is stale,
 * re-read whichever resource you care about". Same shape the spec
 * uses to recover from any out-of-sync condition.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

const HEARTBEAT_GRACE_MS = 90_000; // 3× the server's 30s ping
const OVERFLOW_THRESHOLD = 100;
const RECONNECT_DELAY_MS = 2_000;

/** Raw event shape from the API SSE — mirrors `WSEvent` minus the
 *  discriminated-union sharpness because we cross a JSON boundary. */
interface BridgeEvent {
  type: string;
  projectId?: string;
  ticketId?: string;
  docId?: string;
  userId?: string;
  payload?: { id?: string; ticketKey?: string; isPrivate?: boolean } | null;
}

export interface EventBridgeOpts {
  baseUrl: string;
  apiKey: string;
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
  // Ticket-level events. Include the ticket URI (when the payload
  // carries a ticketKey) AND the project URI so a project-scoped
  // subscriber learns about activity inside it.
  if (event.type === 'ticket:created' || event.type === 'ticket:updated' || event.type === 'ticket:deleted'
   || event.type === 'ticket:activity'
   || event.type === 'comment:created' || event.type === 'comment:updated' || event.type === 'comment:deleted'
   || event.type === 'checklist:created' || event.type === 'checklist:updated' || event.type === 'checklist:deleted'
   || event.type === 'checklist-item:created' || event.type === 'checklist-item:updated' || event.type === 'checklist-item:deleted') {
    const uris: string[] = [];
    const key = event.payload?.ticketKey;
    if (key) uris.push(`orboto://ticket/${key}`);
    // The MCP bridge doesn't know each project's key; the project URI
    // form uses the projectKey which isn't on the wire. We fall back
    // to projectId, which the resource handler accepts via
    // resolveProjectByKey's lookup path.
    if (event.projectId) uris.push(`orboto://project/${event.projectId}`);
    return uris;
  }

  if (event.type === 'project:bulk-activity' || event.type === 'member:joined' || event.type === 'member:removed') {
    return event.projectId ? [`orboto://project/${event.projectId}`] : [];
  }

  if (event.type === 'doc:updated') {
    return event.docId ? [`orboto://doc/${event.docId}`] : [];
  }

  if (event.type === 'timer:changed') {
    return [`orboto://timer`];
  }

  // ORB-706 — mention real-time push. Every notification row firing
  // for the calling user surfaces on `orboto://user/me/notifications`.
  // The API-side SSE bridge already filters notification:new events
  // to only deliver them to the matching user's session, so this
  // URI is naturally per-user-scoped.
  if (event.type === 'notification:new') {
    return [`orboto://user/me/notifications`];
  }

  // restore:progress / system-task:* are user-scoped infrastructure
  // events that don't map to a public resource URI today. The MCP
  // bridge ignores them — the user gets them via the in-app UI.
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
        this.log(`stream closed: ${reason} — retrying in ${RECONNECT_DELAY_MS}ms`);
      }
      if (this.closed) return;
      await new Promise<void>((resolve) => {
        this.retryTimer = setTimeout(resolve, RECONNECT_DELAY_MS);
      });
    }
  }

  private async consume(): Promise<void> {
    const fetchFn = this.opts.fetchFn ?? fetch;
    // Fresh abort controller per attempt so close() during a retry
    // window doesn't leak the previous signal.
    this.abort = new AbortController();
    const url = `${this.opts.baseUrl.replace(/\/$/, '')}/sse/mcp-events`;
    const res = await fetchFn(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${this.opts.apiKey}`,
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
      // If the server's ping stops arriving the underlying TCP
      // connection might be dead silent (Coolify / NAT timeout). Force
      // a reconnect so we don't sit forever on a zombie stream.
      if (Date.now() - lastFrame > HEARTBEAT_GRACE_MS) {
        try { this.abort.abort(); } catch { /* ignore */ }
      }
    }, 30_000);

    try {
      // Read until the stream ends, the request was aborted, or the
      // process is shutting down.
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        lastFrame = Date.now();
        buf += decoder.decode(value, { stream: true });
        // SSE frames are split by '\n\n'. We handle both 'data: ...'
        // and ': ping' (comment / heartbeat) lines; the latter become
        // a no-op event.
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
