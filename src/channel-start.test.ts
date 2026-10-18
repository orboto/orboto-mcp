/**
 * ORB-2584 - the stdio server is a wake channel only for a start that
 * delivers one; the session-start digest prints the lines the server renders.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CHANNEL_START_CUTOVER_VERSION, channelStartFromEnv, CLAUDE_CHANNEL_ENV, releasedBeforeChannelStart } from './channel-start.js';
import { channelClientInfo, toolServerHeartbeat } from './claude-context.js';
import { OrbotoClient } from './orboto-client.js';
import { makeSessionStartHandler } from './tools/session-start.js';
import { whoLine } from './tools/agent-who.js';
import { AGENT_WAKE_LABELS } from './tools/agent-presence-schema.js';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

afterEach(() => { vi.restoreAllMocks(); });

describe('ORB-2584 - the channel needs a channel-enabled start', () => {
  const origin = (version: string) => `host=build-host&pid=4100&client=orboto-cli&version=${version}&harness=claude-code`;

  it('a plain claude launched by a current CLI runs a tool server; orboto claude marks it; ORBOTO_MCP_CHANNEL=0 always wins', () => {
    expect(channelStartFromEnv({ ORBOTO_ORIGIN: origin(CHANNEL_START_CUTOVER_VERSION) })).toBeNull();
    expect(channelStartFromEnv({ ORBOTO_ORIGIN: origin('0.224.3'), CLAUDECODE: '1' })).toBeNull();
    expect(channelStartFromEnv({ ORBOTO_ORIGIN: origin(CHANNEL_START_CUTOVER_VERSION), [CLAUDE_CHANNEL_ENV]: '4242' })).toBe('orboto-claude');
    expect(channelStartFromEnv({ ORBOTO_ORIGIN: origin(CHANNEL_START_CUTOVER_VERSION), [CLAUDE_CHANNEL_ENV]: 'yes' })).toBeNull();
    expect(channelStartFromEnv({ ORBOTO_ORIGIN: origin(CHANNEL_START_CUTOVER_VERSION), ORBOTO_MCP_CHANNEL: '1' })).toBe('explicit');
    expect(channelStartFromEnv({ ORBOTO_MCP_CHANNEL: '0', [CLAUDE_CHANNEL_ENV]: '4242' })).toBeNull();
    expect(channelStartFromEnv({ ORBOTO_MCP_CHANNEL: '0' })).toBeNull();
  });

  it('a launching CLI released before the marker keeps the channel as legacy, read from ORBOTO_ORIGIN or, for a CLI too old to hand one over, ORBOTO_MCP_CLI_OUTDATED; a dev CLI is current', () => {
    expect(channelStartFromEnv({ ORBOTO_ORIGIN: origin('0.223.0') })).toBe('legacy');
    expect(channelStartFromEnv({ ORBOTO_ORIGIN: origin('0.223.1'), ORBOTO_MCP_CLI_OUTDATED: 'orboto CLI 0.223.1 is older than the instance (0.224.0)' })).toBe('legacy');
    expect(channelStartFromEnv({ ORBOTO_MCP_CLI_OUTDATED: 'orboto CLI 0.220.4 is older than the instance (0.224.0)' })).toBe('legacy');
    expect(channelStartFromEnv({ ORBOTO_ORIGIN: origin('0.224.0'), ORBOTO_MCP_CLI_OUTDATED: 'orboto CLI 0.224.0 is older than the instance (0.224.1)' })).toBeNull();
    expect(channelStartFromEnv({ ORBOTO_ORIGIN: origin('dev') })).toBeNull();
  });

  it('a start without any CLI (a hand-configured npx entry) keeps the channel it had before the marker, as legacy', () => {
    expect(channelStartFromEnv({})).toBe('legacy');
    expect(channelStartFromEnv({ CLAUDECODE: '1' })).toBe('legacy');
  });

  it('the cut-over mirrors @orboto/shared-schema', () => {
    const shared = readFileSync(resolve(process.cwd(), '../../packages/shared-schema/src/agent-session-wake.ts'), 'utf8');
    expect(shared).toContain(`export const CHANNEL_START_CUTOVER_VERSION = '${CHANNEL_START_CUTOVER_VERSION}';`);
    for (const v of ['0.223.0', '0.223.1']) expect(releasedBeforeChannelStart(v)).toBe(true);
    for (const v of ['0.224.0', '0.224.0-rc.1', 'dev', '0.0.0', '']) expect(releasedBeforeChannelStart(v)).toBe(false);
  });

  it('a stdio server without a channel heartbeats once as a tool server', () => {
    expect(toolServerHeartbeat(' Build-Host ')).toEqual({ toolServer: true, host: 'build-host' });
  });

  it('the channel heartbeat carries the start marker', () => {
    expect(channelClientInfo(null, '', 'orboto-claude')).toEqual({ channel: 'claude-code', channelStart: 'orboto-claude' });
    expect(channelClientInfo(null, '')).toEqual({ channel: 'claude-code' });
  });

  it('the wake enum and labels mirror @orboto/shared-schema agent-session-wake.ts', () => {
    const shared = readFileSync(resolve(process.cwd(), '../../packages/shared-schema/src/agent-session-wake.ts'), 'utf8');
    expect(shared).toContain("export const AgentSessionWakeSchema = z.enum(['channel', 'stream', 'lane', 'on_call']);");
    for (const [wake, label] of Object.entries(AGENT_WAKE_LABELS)) expect(shared).toContain(`  ${wake}: '${label}',`);
  });

  it('a directory line names a session nothing wakes', () => {
    const line = whoLine({
      sessionId: 's', shortId: 'abcd1234', email: 'claude@example.invalid', role: 'coordinator', projectKeys: [], addresses: [],
      lastSeenAt: 'now', channel: { announced: null, online: false }, wake: 'on_call', currentTicket: null, status: 'idle',
    });
    expect(line).toContain('reads mail only on its own calls');
  });

  it('orboto_session_start prints the server notes and reports the wake', async () => {
    const notes = ['Not carried over: the scope an earlier process of this session row declared (role coordinator; pid 4100).', 'Mail does not wake this session: start it with `orboto claude` to be woken.'];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      const path = new URL(url.toString()).pathname;
      const map: Record<string, unknown> = {
        '/v1/agent/heartbeat': { sessionToken: 'mcp-x', sessionId: 'cbb52195-0000-4000-8000-000000000000', scope: null, wake: 'on_call', scopeExpired: { scope: { role: 'coordinator' }, pid: 4100, startedAt: null, forPid: 5200, expiredAt: 'now' }, notes },
        '/users/me': { email: 'dev@example.invalid', fullName: 'Dev' },
        '/agent-instructions': { instructions: 'rules', rulesHash: 'h' },
      };
      const key = Object.keys(map).find((k) => path === k);
      return { ok: true, status: 200, statusText: 'OK', json: async () => (key ? map[key] : {}), text: async () => '' } as unknown as Response;
    });
    const res = await makeSessionStartHandler(new OrbotoClient({ baseUrl: 'https://orboto.example.invalid', apiKey: 'orb_x' }))({}, { sessionId: 'x' });
    const text = (res.content[0] as { text: string }).text;
    for (const note of notes) expect(text).toContain(note);
    expect(res.structuredContent).toMatchObject({ session: { wake: 'on_call', scopeExpired: { scope: { role: 'coordinator' } } } });
  });
});
