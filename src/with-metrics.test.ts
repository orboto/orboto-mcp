/**
 * ORB-311 Phase F — withMetrics wrapper unit tests.
 *
 * The wrapper's contract:
 *   - Always calls the underlying handler exactly once.
 *   - On success: posts {toolName, durationMs, success: true, ...}.
 *   - On thrown error: posts success: false + errorMessage, re-throws.
 *   - On `result.isError === true`: treats as success: false.
 *   - The instrument POST is fire-and-forget — never delays the caller.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OrbotoClient, OrbotoApiError } from './orboto-client.js';
import { withMetrics } from './with-metrics.js';
import { createNudgeState, SESSION_START_NUDGE } from './session-nudge.js';

beforeEach(() => { vi.restoreAllMocks(); });
afterEach(() => { vi.restoreAllMocks(); });

const client = new OrbotoClient({ baseUrl: 'https://orboto.example.com', apiKey: 'orb_x' });

/** Capture every POST body the client makes and let the test inspect them. */
function captureFetch() {
  const calls: Array<{ url: string; body: unknown }> = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    calls.push({ url: url.toString(), body });
    return {
      ok: true, status: 201, statusText: 'OK',
      json: async () => ({ id: '00000000-0000-0000-0000-000000000001' }),
      text: async () => '',
    } as unknown as Response;
  });
  return calls;
}

describe('withMetrics', () => {
  it('logs success: true with measured duration on a normal handler', async () => {
    const calls = captureFetch();
    const wrapped = withMetrics(client, 'orboto_test', undefined, async () => ({
      content: [{ type: 'text' as const, text: 'ok' }],
    }));
    const result = await wrapped({});
    expect(result.content[0]).toEqual({ type: 'text', text: 'ok' });

    // Wait one microtask so the fire-and-forget POST resolves.
    await new Promise((r) => setImmediate(r));

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain('/admin/mcp/instrument');
    const body = calls[0].body as { toolName: string; success: boolean; durationMs: number };
    expect(body.toolName).toBe('orboto_test');
    expect(body.success).toBe(true);
    expect(body.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('logs success: false + errorMessage when the handler throws, then re-throws', async () => {
    const calls = captureFetch();
    const wrapped = withMetrics(client, 'orboto_explode', undefined, async () => {
      throw new Error('kaboom');
    });

    await expect(wrapped({})).rejects.toThrow('kaboom');
    await new Promise((r) => setImmediate(r));

    const body = calls[0].body as { success: boolean; errorMessage: string };
    expect(body.success).toBe(false);
    expect(body.errorMessage).toBe('kaboom');
  });

  // ORB-1174 — an OrbotoApiError becomes a structured, actionable isError
  // result (not the runtime's opaque generic) so the agent can self-correct.
  it('maps OrbotoApiError to a distinct, actionable isError result per status', async () => {
    captureFetch();
    const run = async (status: number, body: string) => {
      const wrapped = withMetrics(client, 'orboto_x', undefined, async () => {
        throw new OrbotoApiError(status, body, 'https://orboto.example/x');
      });
      const res = await wrapped({});
      expect(res.isError).toBe(true);
      return (res.content[0] as { text: string }).text;
    };

    const unauth = await run(401, '{"error":"Invalid API key"}');
    expect(unauth).toContain('401');
    expect(unauth).toMatch(/re-?authenticate/i);
    expect(unauth).toContain('Invalid API key'); // the API's own message

    const notFound = await run(404, '{"error":"Ticket not found"}');
    expect(notFound).toContain('404');
    expect(notFound).toMatch(/not found/i);

    const server = await run(503, 'upstream down');
    expect(server).toContain('503');
    expect(server).toMatch(/retry/i);

    // distinct messages, not the same opaque blob
    expect(unauth).not.toBe(notFound);
    expect(notFound).not.toBe(server);
  });

  it('treats result.isError=true as success: false (soft failure)', async () => {
    const calls = captureFetch();
    const wrapped = withMetrics(client, 'orboto_softfail', undefined, async () => ({
      content: [{ type: 'text' as const, text: 'permission denied' }],
      isError: true,
    }));
    const result = await wrapped({});
    expect(result.isError).toBe(true);

    await new Promise((r) => setImmediate(r));

    const body = calls[0].body as { success: boolean; errorMessage: string };
    expect(body.success).toBe(false);
    expect(body.errorMessage).toBe('permission denied');
  });

  it('threads clientHint into the log entry', async () => {
    const calls = captureFetch();
    const wrapped = withMetrics(client, 'orboto_test', 'cursor', async () => ({
      content: [{ type: 'text' as const, text: 'ok' }],
    }));
    await wrapped({});
    await new Promise((r) => setImmediate(r));

    const body = calls[0].body as { clientHint?: string };
    expect(body.clientHint).toBe('cursor');
  });

  it('does not block when the instrument POST fails — handler still resolves', async () => {
    // First call (the handler-as-fetch?) returns ok; but our handler
    // doesn't fetch; the only fetch the wrapper makes is to /instrument.
    // Mock that one to fail — caller must still get the original
    // result back.
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => ({
      ok: false, status: 500, statusText: 'Server Error',
      json: async () => ({ error: 'kaboom' }),
      text: async () => '',
    } as unknown as Response));

    const wrapped = withMetrics(client, 'orboto_test', undefined, async () => ({
      content: [{ type: 'text' as const, text: 'survives' }],
    }));
    const result = await wrapped({});
    expect(result.content[0]).toEqual({ type: 'text', text: 'survives' });
  });

  // ORB-1180 — admin-panel visibility: the failure log carries the
  // structured HTTP status, and any secret-shaped text is redacted.
  it('logs the structured statusCode on an OrbotoApiError', async () => {
    const calls = captureFetch();
    const wrapped = withMetrics(client, 'orboto_x', undefined, async () => {
      throw new OrbotoApiError(403, '{"error":"Forbidden"}', 'https://orboto.example/x');
    });
    await wrapped({});
    await new Promise((r) => setImmediate(r));
    const body = calls[0].body as { success: boolean; statusCode: number; errorMessage: string };
    expect(body.success).toBe(false);
    expect(body.statusCode).toBe(403);
    expect(body.errorMessage).toContain('403');
  });

  // ORB-1331 — the shared nudge state threads through the wrapper: the
  // first non-session_start dispatch carries the one-time reminder,
  // later dispatches are clean, and a session_start-first flow never
  // sees it. structuredContent is left intact.
  it('prepends the session-start nudge on the first non-session_start dispatch, once', async () => {
    captureFetch();
    const nudge = createNudgeState();
    const handler = async () => ({
      content: [{ type: 'text' as const, text: 'ok' }],
      structuredContent: { a: 1 },
    });
    const list = withMetrics(client, 'orboto_list_projects', undefined, handler, nudge);

    const first = await list({});
    expect((first.content[0] as { text: string }).text).toBe(SESSION_START_NUDGE);
    expect((first.content[1] as { text: string }).text).toBe('ok');
    expect(first.structuredContent).toEqual({ a: 1 }); // untouched

    const second = await list({});
    expect((second.content[0] as { text: string }).text).toBe('ok'); // clean
  });

  it('does not nudge when the first dispatch IS orboto_session_start', async () => {
    captureFetch();
    const nudge = createNudgeState();
    const handler = async () => ({ content: [{ type: 'text' as const, text: 'rules' }] });
    const start = withMetrics(client, 'orboto_session_start', undefined, handler, nudge);
    const list = withMetrics(client, 'orboto_list_projects', undefined, handler, nudge);

    const first = await start({});
    expect((first.content[0] as { text: string }).text).toBe('rules'); // no nudge

    const second = await list({});
    expect((second.content[0] as { text: string }).text).toBe('rules'); // still clean
  });

  it('surfaces the nudge alongside an OrbotoApiError on a first-call failure', async () => {
    captureFetch();
    const nudge = createNudgeState();
    const wrapped = withMetrics(client, 'orboto_list_projects', undefined, async () => {
      throw new OrbotoApiError(403, '{"error":"Forbidden"}', 'https://orboto.example/x');
    }, nudge);
    const res = await wrapped({});
    expect(res.isError).toBe(true);
    expect((res.content[0] as { text: string }).text).toBe(SESSION_START_NUDGE);
    expect((res.content[1] as { text: string }).text).toContain('403');
  });

  it('redacts secret-shaped text from the logged errorMessage', async () => {
    const calls = captureFetch();
    const wrapped = withMetrics(client, 'orboto_x', undefined, async () => {
      throw new Error('failed with token orb_abcdef1234567890 and Bearer eyJabcdefghij.k.l');
    });
    await expect(wrapped({})).rejects.toThrow();
    await new Promise((r) => setImmediate(r));
    const body = calls[0].body as { errorMessage: string };
    expect(body.errorMessage).not.toContain('orb_abcdef1234567890');
    expect(body.errorMessage).toContain('orb_[redacted]');
    expect(body.errorMessage).not.toContain('eyJabcdefghij.k.l');
  });
});
