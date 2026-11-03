/**
 * ORB-2818 - lane pause, resume and stop tools.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OrbotoClient } from '../orboto-client.js';
import { summarizeToolDescription, SUMMARY_MAX_CHARS } from '../tool-docs.js';
import {
  laneControlToolConfig, laneStopToolConfig, makeLaneControlHandler, makeLaneStopHandler,
} from './agent-lanes.js';

beforeEach(() => { vi.restoreAllMocks(); });
afterEach(() => { vi.restoreAllMocks(); });

function stub(responses: Array<{ ok?: boolean; status?: number; json?: unknown }>) {
  const calls: Array<{ url: string; method: string; body?: unknown }> = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    const method = init?.method ?? 'GET';
    calls.push({ url: url.toString(), method, body: init?.body ? JSON.parse(init.body as string) : undefined });
    const r = responses.shift();
    if (!r) throw new Error(`unexpected extra fetch ${method} ${url.toString()}`);
    return {
      ok: r.ok ?? true,
      status: r.status ?? 200,
      statusText: 'OK',
      headers: new Headers(),
      json: async () => ('json' in r ? r.json : {}),
      text: async () => (typeof r.json === 'string' ? r.json : ''),
    } as unknown as Response;
  });
  return calls;
}

const client = new OrbotoClient({ baseUrl: 'https://orboto.example.com', apiKey: 'orb_x' });
const REVIEW_ID = '11111111-1111-4111-8111-111111111111';
const BUILD_ID = '22222222-2222-4222-8222-222222222222';

function lane(over: Record<string, unknown> = {}) {
  return {
    id: REVIEW_ID, name: 'review-1', status: 'working', online: true, paused: true,
    stopRequestedAt: null, currentTicketKey: 'ORB-7', ...over,
  };
}

const text = (res: { content: unknown[] }) => (res.content[0] as { text: string }).text;

describe('orboto_lane_pause', () => {
  it('resolves the name through the lane list and posts the pause with the trimmed reason', async () => {
    const calls = stub([
      { json: { items: [lane({ id: BUILD_ID, name: 'build-1' }), lane()], freshnessSeconds: 90 } },
      { json: lane() },
    ]);
    const res = await makeLaneControlHandler(client)({ lane: 'review-1', action: 'pause', reason: '  deploy window  ' });
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      'GET https://orboto.example.com/admin/agent-lanes',
      `POST https://orboto.example.com/admin/agent-lanes/${REVIEW_ID}/pause`,
    ]);
    expect(calls[1]!.body).toEqual({ reason: 'deploy window' });
    expect(text(res)).toContain('paused at the next turn boundary');
    expect(text(res)).toContain('the running turn on ORB-7 finishes and the work session is held');
    expect(res.structuredContent).toMatchObject({
      action: 'pause',
      lane: { id: REVIEW_ID, name: 'review-1', paused: true, stopRequestedAt: null, currentTicketKey: 'ORB-7' },
    });
  });

  it('matches the name case-insensitively and sends an empty body without a reason', async () => {
    const calls = stub([
      { json: { items: [lane({ name: 'Review-1' })], freshnessSeconds: 90 } },
      { json: lane({ name: 'Review-1', status: 'idle', currentTicketKey: null }) },
    ]);
    const res = await makeLaneControlHandler(client)({ lane: 'REVIEW-1', action: 'pause' });
    expect(calls[1]!.url).toBe(`https://orboto.example.com/admin/agent-lanes/${REVIEW_ID}/pause`);
    expect(calls[1]!.body).toEqual({});
    expect(text(res)).not.toContain('the running turn');
  });

  it('says a pending stop now stays pending after a pause and promises no turn boundary', async () => {
    stub([{ json: lane({ stopRequestedAt: '2026-11-04T10:00:00.000Z' }) }]);
    const res = await makeLaneControlHandler(client)({ lane: REVIEW_ID, action: 'pause' });
    expect(text(res)).toContain('a stop now is still pending; resume clears it');
    expect(text(res)).not.toContain('turn boundary');
    expect(text(res)).not.toContain('work session is held');
    expect(res.structuredContent).toMatchObject({ action: 'pause', lane: { stopRequestedAt: '2026-11-04T10:00:00.000Z' } });
  });

  it('resumes a held task in the same work session', async () => {
    const calls = stub([
      { json: { items: [lane()], freshnessSeconds: 90 } },
      { json: lane({ paused: false }) },
    ]);
    const res = await makeLaneControlHandler(client)({ lane: 'review-1', action: 'resume' });
    expect(calls[1]!.url).toBe(`https://orboto.example.com/admin/agent-lanes/${REVIEW_ID}/resume`);
    expect(text(res)).toContain('a held task continues in the same work session, with no new attempt');
    expect(res.structuredContent).toMatchObject({ action: 'resume', lane: { paused: false } });
  });

  it('takes a UUID directly without listing the lanes', async () => {
    const calls = stub([{ json: lane() }]);
    await makeLaneControlHandler(client)({ lane: REVIEW_ID.toUpperCase(), action: 'pause' });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.url).toContain(`/admin/agent-lanes/${REVIEW_ID.toUpperCase()}/pause`);
  });

  it('names the existing lanes for an unknown name and posts nothing', async () => {
    const calls = stub([{ json: { items: [lane({ name: 'zeta' }), lane({ id: BUILD_ID, name: 'alpha' })], freshnessSeconds: 90 } }]);
    await expect(makeLaneControlHandler(client)({ lane: 'nope', action: 'pause' }))
      .rejects.toThrow(/No agent lane named "nope"\. Existing lanes: "alpha", "zeta"\./);
    expect(calls).toHaveLength(1);
  });

  it('refuses a name that matches two lanes only by case', async () => {
    stub([{ json: { items: [lane({ name: 'Review' }), lane({ id: BUILD_ID, name: 'REVIEW' })], freshnessSeconds: 90 } }]);
    await expect(makeLaneControlHandler(client)({ lane: 'review', action: 'pause' })).rejects.toThrow(/ambiguous/);
  });

  it('prefers the exact name over a case-insensitive twin', async () => {
    const calls = stub([
      { json: { items: [lane({ name: 'Review' }), lane({ id: BUILD_ID, name: 'review' })], freshnessSeconds: 90 } },
      { json: lane({ id: BUILD_ID, name: 'review' }) },
    ]);
    await makeLaneControlHandler(client)({ lane: 'review', action: 'pause' });
    expect(calls[1]!.url).toContain(`/${BUILD_ID}/pause`);
  });

  it('maps a 403 on the write to the admin:agent_lanes:write permission', async () => {
    stub([
      { json: { items: [lane()], freshnessSeconds: 90 } },
      { ok: false, status: 403, json: 'Forbidden' },
    ]);
    await expect(makeLaneControlHandler(client)({ lane: 'review-1', action: 'pause' }))
      .rejects.toThrow(/requires the admin:agent_lanes:write permission/);
  });

  it('maps a 403 on the lane list to the read permission and the UUID way out', async () => {
    stub([{ ok: false, status: 403, json: 'Forbidden' }]);
    await expect(makeLaneControlHandler(client)({ lane: 'review-1', action: 'resume' }))
      .rejects.toThrow(/admin:agent_lanes:read.*UUID/);
  });

  it('maps a 404 for a UUID nobody owns to a clear message', async () => {
    stub([{ ok: false, status: 404, json: 'Not found' }]);
    await expect(makeLaneControlHandler(client)({ lane: BUILD_ID, action: 'pause' }))
      .rejects.toThrow(`No agent lane with id ${BUILD_ID}.`);
  });

  it('lets any other API failure through unchanged', async () => {
    stub([{ ok: false, status: 500, json: 'boom' }]);
    await expect(makeLaneControlHandler(client)({ lane: BUILD_ID, action: 'pause' })).rejects.toThrow(/orboto API 500/);
  });
});

describe('orboto_lane_stop', () => {
  it('posts the stop and says the turn is interrupted, the lane stays paused and the next run is a new attempt', async () => {
    const calls = stub([
      { json: { items: [lane()], freshnessSeconds: 90 } },
      { json: lane({ stopRequestedAt: '2026-11-04T10:00:00.000Z' }) },
    ]);
    const res = await makeLaneStopHandler(client)({ lane: 'review-1', reason: 'wrong branch' });
    expect(calls[1]!.method).toBe('POST');
    expect(calls[1]!.url).toBe(`https://orboto.example.com/admin/agent-lanes/${REVIEW_ID}/stop`);
    expect(calls[1]!.body).toEqual({ reason: 'wrong branch' });
    expect(text(res)).toContain('interrupts the running turn at its next heartbeat (the runner\'s poll interval)');
    expect(text(res)).not.toContain('30 s');
    expect(text(res)).toContain('stays paused until orboto_lane_pause with action resume');
    expect(text(res)).toContain('new attempt');
    expect(res.structuredContent).toMatchObject({
      action: 'stop',
      lane: { id: REVIEW_ID, paused: true, stopRequestedAt: '2026-11-04T10:00:00.000Z' },
    });
  });

  it('maps a 403 to the write permission and an unknown name to the lane list', async () => {
    stub([
      { json: { items: [lane()], freshnessSeconds: 90 } },
      { ok: false, status: 403, json: 'Forbidden' },
    ]);
    await expect(makeLaneStopHandler(client)({ lane: 'review-1' })).rejects.toThrow(/Lane stop requires the admin:agent_lanes:write permission/);
    stub([{ json: { items: [], freshnessSeconds: 90 } }]);
    await expect(makeLaneStopHandler(client)({ lane: 'review-1' })).rejects.toThrow(/Existing lanes: \(none\)/);
  });
});

describe('lane control tool configs', () => {
  it('annotate the pause as an idempotent non-destructive write and the stop as a destructive one', () => {
    expect(laneControlToolConfig.annotations).toEqual({ readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false });
    expect(laneStopToolConfig.annotations).toEqual({ readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false });
    for (const cfg of [laneControlToolConfig, laneStopToolConfig]) expect(cfg.title.length).toBeLessThanOrEqual(64);
  });

  it('carry the pause versus stop difference in the wire summary', () => {
    const pause = summarizeToolDescription('orboto_lane_pause', laneControlToolConfig.description);
    const stop = summarizeToolDescription('orboto_lane_stop', laneStopToolConfig.description);
    expect(pause.length).toBeLessThanOrEqual(SUMMARY_MAX_CHARS);
    expect(stop.length).toBeLessThanOrEqual(SUMMARY_MAX_CHARS);
    expect(pause).toMatch(/next turn boundary.*work session is held.*orboto_lane_stop interrupts the running turn/);
    expect(stop).toMatch(/interrupts the running turn.*stays paused until resume/);
  });

  it('bound the lane and reason inputs', () => {
    const pauseShape = laneControlToolConfig.inputSchema;
    expect(pauseShape.reason.safeParse('x'.repeat(501)).success).toBe(false);
    expect(pauseShape.lane.safeParse('x'.repeat(65)).success).toBe(false);
    expect(pauseShape.lane.safeParse('   ').success).toBe(false);
    expect(pauseShape.action.safeParse('stop').success).toBe(false);
    expect(laneStopToolConfig.inputSchema.reason.safeParse('x'.repeat(500)).success).toBe(true);
  });
});
