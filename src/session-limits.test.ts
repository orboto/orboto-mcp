import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildOrbotoMcpServer } from './server.js';
import { McpError } from '@modelcontextprotocol/sdk/types.js';
import {
  assertSubscribable,
  MAX_SUBSCRIPTIONS_PER_SESSION,
  MAX_SUBSCRIPTION_URI_LENGTH,
  resolveSessionLimits,
  sessionsOverOwnerCap,
  uriForLog,
} from './session-limits.js';

describe('resource subscription bounds', () => {
  it('accepts an orboto resource URI', () => {
    expect(() => assertSubscribable(new Set(), 'orboto://ticket/ORB-1')).not.toThrow();
  });

  it('rejects a URI outside the orboto scheme or over the length limit', () => {
    expect(() => assertSubscribable(new Set(), 'https://example.com/x')).toThrow(McpError);
    expect(() => assertSubscribable(new Set(), `orboto://ticket/${'x'.repeat(MAX_SUBSCRIPTION_URI_LENGTH)}`)).toThrow(McpError);
  });

  it('rejects a new URI once the session holds the maximum, but re-subscribing a held one stays fine', () => {
    const subs = new Set(Array.from({ length: MAX_SUBSCRIPTIONS_PER_SESSION }, (_, i) => `orboto://ticket/T-${i}`));
    expect(() => assertSubscribable(subs, 'orboto://ticket/NEW-1')).toThrow(McpError);
    expect(() => assertSubscribable(subs, 'orboto://ticket/T-0')).not.toThrow();
  });

  it('shortens long URIs in the log line', () => {
    expect(uriForLog(`orboto://search/${'q'.repeat(1000)}`).length).toBeLessThan(210);
  });
});

describe('resources/subscribe handler', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  async function connect(subscriptions: Set<string>) {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline test'));
    const server = await buildOrbotoMcpServer({ baseUrl: 'https://x.test', apiKey: 'orb_k', subscriptions, toolset: 'curated' });
    const client = new Client({ name: 't', version: '0' });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(a), client.connect(b)]);
    return client;
  }

  it('stores a valid URI and refuses an oversized or foreign one without storing it', async () => {
    const subs = new Set<string>();
    const client = await connect(subs);
    await client.subscribeResource({ uri: 'orboto://ticket/ORB-1' });
    await expect(client.subscribeResource({ uri: `orboto://search/${'x'.repeat(5000)}` })).rejects.toThrow();
    await expect(client.subscribeResource({ uri: 'file:///etc/passwd' })).rejects.toThrow();
    expect([...subs]).toEqual(['orboto://ticket/ORB-1']);
  });
});

describe('session cap selection', () => {
  it('picks the oldest sessions of the owner only', () => {
    const sessions = [
      { id: 'a1', userEmail: 'a', lastActiveAt: 3 },
      { id: 'a2', userEmail: 'a', lastActiveAt: 1 },
      { id: 'b1', userEmail: 'b', lastActiveAt: 0 },
      { id: 'a3', userEmail: 'a', lastActiveAt: 2 },
    ];
    expect(sessionsOverOwnerCap(sessions, 'a', 2).map((s) => s.id)).toEqual(['a2', 'a3']);
    expect(sessionsOverOwnerCap(sessions, 'b', 2)).toEqual([]);
  });

  it('reads the limits from the environment with safe fallbacks', () => {
    expect(resolveSessionLimits({ ORBOTO_MCP_MAX_SESSIONS_PER_USER: '4', ORBOTO_MCP_SESSION_IDLE_MS: '1000' })).toEqual({
      maxSessionsPerUser: 4, idleMs: 1000, reapIntervalMs: 1000,
    });
    expect(resolveSessionLimits({ ORBOTO_MCP_MAX_SESSIONS_PER_USER: 'junk' }).maxSessionsPerUser).toBe(32);
  });
});
