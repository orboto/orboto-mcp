import { afterEach, describe, expect, it, vi } from 'vitest';

const spawn = vi.fn(() => ({ unref: () => {} }));
vi.mock('node:child_process', () => ({ spawn }));

const { openInBrowser } = await import('./oauth-bootstrap.js');

const realPlatform = process.platform;
function setPlatform(p: NodeJS.Platform) {
  Object.defineProperty(process, 'platform', { value: p, configurable: true });
}

afterEach(() => {
  setPlatform(realPlatform);
  spawn.mockClear();
  delete process.env.ORBOTO_MCP_NO_BROWSER;
});

const URL_WITH_METACHARS = 'https://auth.example.test/authorize&calc.exe|x^y?client_id=a&state=b';

describe('OAuth browser opener', () => {
  it('opens the URL on Windows without a command shell, as a single argument', async () => {
    setPlatform('win32');
    expect(await openInBrowser(URL_WITH_METACHARS)).toBe(true);
    expect(spawn).toHaveBeenCalledTimes(1);
    const [cmd, args] = spawn.mock.calls[0] as unknown as [string, string[]];
    expect(cmd).not.toMatch(/cmd|powershell/i);
    expect(args.filter((a) => a.includes('auth.example.test'))).toHaveLength(1);
    expect(args).not.toContain('/c');
  });

  it('opens the URL directly on macOS and Linux', async () => {
    setPlatform('linux');
    await openInBrowser('https://auth.example.test/authorize?x=1');
    expect(spawn.mock.calls[0]).toEqual(['xdg-open', ['https://auth.example.test/authorize?x=1'], expect.anything()]);
  });

  it('refuses anything but an http or https URL', async () => {
    setPlatform('win32');
    for (const url of ['file:///C:/Windows/System32/calc.exe', 'javascript:alert(1)', 'not a url']) {
      expect(await openInBrowser(url)).toBe(false);
    }
    expect(spawn).not.toHaveBeenCalled();
  });
});
