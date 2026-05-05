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
import { OrbotoClient } from './orboto-client.js';
import { withMetrics } from './with-metrics.js';

beforeEach(() => { vi.restoreAllMocks(); });
afterEach(() => { vi.restoreAllMocks(); });

const client = new OrbotoClient({ baseUrl: 'https://orboto.example.com', apiKey: 'obo_x' });

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
    const wrapped = withMetrics(client, 'orbit_explode', undefined, async () => {
      throw new Error('kaboom');
    });

    await expect(wrapped({})).rejects.toThrow('kaboom');
    await new Promise((r) => setImmediate(r));

    const body = calls[0].body as { success: boolean; errorMessage: string };
    expect(body.success).toBe(false);
    expect(body.errorMessage).toBe('kaboom');
  });

  it('treats result.isError=true as success: false (soft failure)', async () => {
    const calls = captureFetch();
    const wrapped = withMetrics(client, 'orbit_softfail', undefined, async () => ({
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
});
