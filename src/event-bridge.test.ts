/**
 * ORB-940 - EventBridge unit tests.
 *
 * Three concerns:
 *   1. Event → URI mapping (pure function, no I/O)
 *   2. Dispatch behaviour - subscribed URIs trigger
 *      sendResourceUpdated, unsubscribed do not
 *   3. Backpressure - > 100 forwarded events → one
 *      sendResourceListChanged instead of more updates
 *
 * The actual SSE consumption path is exercised via a streaming
 * mock fetch; the response body is a ReadableStream that yields
 * one frame per chunk, then closes.
 */
import { describe, expect, it, vi } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { EventBridge, eventToUris } from './event-bridge.js';

function mockMcp() {
  const sendResourceUpdated = vi.fn().mockResolvedValue(undefined);
  const sendResourceListChanged = vi.fn().mockResolvedValue(undefined);
  return {
    server: { sendResourceUpdated, sendResourceListChanged },
    sendResourceUpdated,
    sendResourceListChanged,
  } as unknown as McpServer & {
    sendResourceUpdated: ReturnType<typeof vi.fn>;
    sendResourceListChanged: ReturnType<typeof vi.fn>;
  };
}

/** Build a Response with a body that emits the given SSE frames in
 *  order, then closes. Each `frame` becomes `data: <json>\n\n`. */
function mockSseResponse(frames: unknown[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const frame of frames) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(frame)}\n\n`));
      }
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

describe('eventToUris', () => {
  it('maps ticket:updated to both ticket and project URIs', () => {
    const uris = eventToUris({
      type: 'ticket:updated',
      projectId: 'p1',
      payload: { ticketKey: 'ORB-42' },
    });
    expect(uris).toEqual(['orboto://ticket/ORB-42', 'orboto://project/p1']);
  });

  it('maps comment events to the ticket URI when ticketKey is present', () => {
    const uris = eventToUris({
      type: 'comment:created',
      projectId: 'p1',
      payload: { ticketKey: 'ORB-99' },
    });
    expect(uris).toEqual(['orboto://ticket/ORB-99', 'orboto://project/p1']);
  });

  it('maps doc:updated to a doc URI', () => {
    expect(eventToUris({ type: 'doc:updated', docId: 'd1' })).toEqual(['orboto://doc/d1']);
  });

  it('maps timer:changed to the singleton timer URI', () => {
    expect(eventToUris({ type: 'timer:changed', userId: 'u1' })).toEqual(['orboto://timer']);
  });

  it('maps notification:new to the calling user\'s notifications resource (ORB-706)', () => {
    // The mcp-events SSE handler already filters notification:new
    // to only deliver to the matching user; the URI is per-user
    // scoped by construction.
    expect(eventToUris({ type: 'notification:new', userId: 'u1' })).toEqual(['orboto://user/me/notifications']);
  });

  it('returns [] for restore-progress / system-task events (infrastructure-only)', () => {
    expect(eventToUris({ type: 'restore:progress', userId: 'u1' } as never)).toEqual([]);
  });

  it('emits orboto://handoff/closed/<key> on a ticket:updated to done (ORB-962)', () => {
    const uris = eventToUris({
      type: 'ticket:updated',
      projectId: 'p1',
      payload: { ticketKey: 'ORB-42', statusCategory: 'done' },
    });
    expect(uris).toContain('orboto://ticket/ORB-42');
    expect(uris).toContain('orboto://handoff/closed/ORB-42');
  });

  it('does NOT emit handoff URI when a ticket:updated keeps a non-done status', () => {
    const uris = eventToUris({
      type: 'ticket:updated',
      projectId: 'p1',
      payload: { ticketKey: 'ORB-42', statusCategory: 'in_progress' },
    });
    expect(uris).not.toContain('orboto://handoff/closed/ORB-42');
  });
});

describe('EventBridge.dispatch', () => {
  it('forwards subscribed URIs and ignores the rest', async () => {
    const mcp = mockMcp();
    const subscriptions = new Set(['orboto://ticket/ORB-42']);
    const fetchFn = vi.fn().mockResolvedValueOnce(mockSseResponse([
      { type: 'ticket:updated', projectId: 'p1', payload: { ticketKey: 'ORB-42' } },
      { type: 'ticket:updated', projectId: 'p1', payload: { ticketKey: 'ORB-99' } },
    ]));

    const bridge = new EventBridge({
      baseUrl: 'https://orboto.example.com',
      apiKey: 'orb_x',
      mcp,
      subscriptions,
      fetchFn: fetchFn as unknown as typeof fetch,
      log: () => { /* silence */ },
    });
    bridge.start();
    // Give the microtask loop a couple of ticks to drain.
    await new Promise((r) => setTimeout(r, 50));
    bridge.close();

    expect(mcp.sendResourceUpdated).toHaveBeenCalledTimes(1);
    expect(mcp.sendResourceUpdated).toHaveBeenCalledWith({ uri: 'orboto://ticket/ORB-42' });
  });

  it('falls back to sendResourceListChanged after the overflow threshold', async () => {
    const mcp = mockMcp();
    const subscriptions = new Set(['orboto://timer']);
    // 101 timer events - one more than the threshold so the 101st
    // round trips through the list_changed path.
    const frames = Array.from({ length: 101 }, () => ({ type: 'timer:changed', userId: 'u1' }));
    const fetchFn = vi.fn().mockResolvedValueOnce(mockSseResponse(frames));

    const bridge = new EventBridge({
      baseUrl: 'https://orboto.example.com',
      apiKey: 'orb_x',
      mcp,
      subscriptions,
      fetchFn: fetchFn as unknown as typeof fetch,
      log: () => { /* silence */ },
    });
    bridge.start();
    await new Promise((r) => setTimeout(r, 100));
    bridge.close();

    expect(mcp.sendResourceUpdated).toHaveBeenCalledTimes(100);
    expect(mcp.sendResourceListChanged).toHaveBeenCalledTimes(1);
  });

  it('survives malformed frames without aborting the stream', async () => {
    const mcp = mockMcp();
    const subscriptions = new Set(['orboto://ticket/ORB-42']);
    // Inject one bad frame between two good ones - the bad frame is
    // a non-JSON 'data:' line, which the bridge should skip.
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'ticket:updated', projectId: 'p1', payload: { ticketKey: 'ORB-42' } })}\n\n`));
        controller.enqueue(encoder.encode('data: not-json\n\n'));
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'ticket:updated', projectId: 'p1', payload: { ticketKey: 'ORB-42' } })}\n\n`));
        controller.close();
      },
    });
    const fetchFn = vi.fn().mockResolvedValueOnce(new Response(stream, { status: 200 }));

    const bridge = new EventBridge({
      baseUrl: 'https://orboto.example.com',
      apiKey: 'orb_x',
      mcp,
      subscriptions,
      fetchFn: fetchFn as unknown as typeof fetch,
      log: () => { /* silence */ },
    });
    bridge.start();
    await new Promise((r) => setTimeout(r, 50));
    bridge.close();

    expect(mcp.sendResourceUpdated).toHaveBeenCalledTimes(2);
  });
});
