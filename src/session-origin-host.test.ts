/**
 * ORB-2901 - a stdio proxy names the host the machine has at each request,
 * never the one it had when the proxy started: macOS renames the host with
 * the network, and the CLI beside the proxy reads it anew on every call.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const machine = vi.hoisted(() => ({ host: 'studio-mbp' }));
vi.mock('node:os', async (importOriginal) => ({ ...(await importOriginal<typeof import('node:os')>()), hostname: () => machine.host }));

const { originHeader } = await import('./session-origin.js');

const handed = process.env.ORBOTO_ORIGIN;
afterEach(() => {
  if (handed === undefined) delete process.env.ORBOTO_ORIGIN;
  else process.env.ORBOTO_ORIGIN = handed;
});

describe('ORB-2901 - the origin names the current host', () => {
  it('replaces the host the CLI handed over with the one the machine has now, and keeps every other field', () => {
    process.env.ORBOTO_ORIGIN = 'host=studio-mbp&machine=0123456789abcdef&pid=4300&start=2026-10-29T09%3A58%3A26Z&harness=claude-code&client=orboto-cli&version=0.235.0';
    const first = new URLSearchParams(originHeader());
    expect(first.get('host')).toBe('studio-mbp');

    machine.host = 'Studio-MacBook-Pro.example.lan';
    const renamed = new URLSearchParams(originHeader());
    expect(renamed.get('host')).toBe('studio-macbook-pro');
    expect([renamed.get('machine'), renamed.get('pid'), renamed.get('start'), renamed.get('harness'), renamed.get('client')])
      .toEqual(['0123456789abcdef', '4300', '2026-10-29T09:58:26Z', 'claude-code', 'orboto-mcp']);
  });
});
