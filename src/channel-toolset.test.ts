/**
 * ORB-2210 - the `channel` toolset: no tools, CLI-first instructions, and
 * the wake channel still delivers into the connected session.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { z } from 'zod';
import { buildOrbotoMcpServer } from './server.js';
import { CHANNEL_CAPABILITY, CHANNEL_METHOD, InboxChannel } from './inbox-channel.js';
import { resolveToolset, toolInToolset } from './toolset.js';

beforeEach(() => { delete process.env.ORBOTO_MCP_TOOLSET; });
afterEach(() => { vi.restoreAllMocks(); delete process.env.ORBOTO_MCP_TOOLSET; });

const ChannelNotification = z.object({
  method: z.literal(CHANNEL_METHOD),
  params: z.object({ content: z.string(), meta: z.record(z.string()) }),
});

function sse(frames: unknown[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const frame of frames) controller.enqueue(encoder.encode(`data: ${JSON.stringify(frame)}\n\n`));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

async function connectChannelServer() {
  const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline test'));
  const server = await buildOrbotoMcpServer({ baseUrl: 'https://x.test', apiKey: 'orb_k', channel: true, toolset: 'channel' });
  const client = new Client({ name: 't', version: '0' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  return { server, client, fetchSpy };
}

describe('resolveToolset / toolInToolset - channel', () => {
  it('channel resolves from either surface and admits no tool', () => {
    expect(resolveToolset('channel', undefined)).toBe('channel');
    expect(resolveToolset(undefined, 'channel')).toBe('channel');
    expect(resolveToolset('channel', 'full')).toBe('channel');
    for (const name of ['orboto_session_start', 'orboto_get_ticket', 'orboto_api_call', 'orboto_messages']) {
      expect(toolInToolset(name, 'channel'), name).toBe(false);
    }
  });
});

describe('ORB-2210 - the channel toolset', () => {
  it('starts, answers initialize, registers no tool, prompt or resource, and fetches no rules at connect', async () => {
    const { server, client, fetchSpy } = await connectChannelServer();
    expect(client.getServerVersion()?.name).toBe('orboto');
    expect(client.getServerCapabilities()?.tools).toBeUndefined();
    expect(client.getServerCapabilities()?.prompts).toBeUndefined();
    expect(client.getServerCapabilities()?.resources).toBeUndefined();
    expect(client.getServerCapabilities()?.experimental).toHaveProperty(CHANNEL_CAPABILITY);
    expect(fetchSpy).not.toHaveBeenCalled();
    await client.close(); await server.close();
  });

  it('instructions point at the CLI, the scope command and the way back to the tools', async () => {
    const { server, client } = await connectChannelServer();
    const text = client.getInstructions() ?? '';
    expect(text).toContain('`orboto help`');
    expect(text).toContain('orboto session-start');
    expect(text).toContain('orboto agent-heartbeat --role');
    expect(text).toContain('--scope-projects');
    expect(text).toContain('ORBOTO_MCP_TOOLSET=curated|full');
    expect(text).toContain('orboto messages --ack');
    expect(text).not.toMatch(/orboto_[a-z_]+/);
    await client.close(); await server.close();
  });

  it('a streamed inbox message reaches the connected client as a channel event', async () => {
    const { server, client } = await connectChannelServer();
    const received: Array<z.infer<typeof ChannelNotification>['params']> = [];
    client.setNotificationHandler(ChannelNotification, (n) => { received.push(n.params); });
    const fetchFn = vi.fn().mockResolvedValueOnce(sse([{
      id: 'm1', fromUserId: 'u-spec', kind: 'request', subject: 'ticket-ready:ORB-1', payload: { message: 'please take it' },
      threadId: null, projectKey: 'ORB', createdAt: new Date().toISOString(),
    }])).mockImplementation(() => new Promise(() => { /* the reconnect never resolves */ }));
    const inbox = new InboxChannel({ baseUrl: 'https://x.test', apiKey: 'orb_k', instanceToken: 'mcp-proc', mcp: server, fetchFn, log: () => {}, digestMinutes: 15 });
    inbox.start();
    await vi.waitFor(() => expect(received).toHaveLength(1));
    expect(received[0].meta).toMatchObject({ id: 'm1', kind: 'request', project: 'ORB' });
    expect(received[0].content).toContain('ticket-ready:ORB-1');
    expect(inbox.stats.delivered).toBe(1);
    inbox.close();
    await client.close(); await server.close();
  });
});
