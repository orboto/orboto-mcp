/**
 * ORB-2149 - the proxy reports a context size only when exactly one fresh
 * report belongs to its directory.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readClaudeContext } from './claude-context.js';

let root: string;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'orboto-ctx-'));
  mkdirSync(root, { recursive: true });
});
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

function write(name: string, body: Record<string, unknown>) {
  writeFileSync(path.join(root, name), JSON.stringify(body));
}

describe('ORB-2149 - claude statusline context reports', () => {
  it('reports the one fresh file for this directory', () => {
    write('a.json', { cwd: '/work/repo', contextTokens: 120_000, contextWindowSize: 200_000, updatedAt: new Date().toISOString() });
    write('b.json', { cwd: '/elsewhere', contextTokens: 5, updatedAt: new Date().toISOString() });
    expect(readClaudeContext('/work/repo', Date.now(), root)).toEqual({ contextTokens: 120_000, contextWindowSize: 200_000 });
  });

  it('reports nothing for a stale report, an unknown directory, a broken file or two sessions in one directory', () => {
    write('stale.json', { cwd: '/work/repo', contextTokens: 1, updatedAt: new Date(Date.now() - 20 * 60_000).toISOString() });
    expect(readClaudeContext('/work/repo', Date.now(), root)).toBeNull();
    expect(readClaudeContext('/nothing/here', Date.now(), root)).toBeNull();

    write('broken.json', { cwd: '/work/two' });
    expect(readClaudeContext('/work/two', Date.now(), root)).toBeNull();

    write('one.json', { cwd: '/work/two', contextTokens: 10, updatedAt: new Date().toISOString() });
    write('two.json', { cwd: '/work/two', contextTokens: 20, updatedAt: new Date().toISOString() });
    expect(readClaudeContext('/work/two', Date.now(), root)).toBeNull();
  });

  it('reports nothing when the directory does not exist', () => {
    expect(readClaudeContext('/work/repo', Date.now(), path.join(root, 'missing'))).toBeNull();
  });
});
