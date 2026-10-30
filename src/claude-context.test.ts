/**
 * ORB-2149 - the proxy reports a context size only when exactly one fresh
 * report belongs to its directory.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { channelClientInfo, claudeContextDir, newestSample, readClaudeContext, readClaudeReport, unsentSamples } from './claude-context.js';

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

describe('ORB-2729 - the account and the usage samples ride the heartbeat', () => {
  const sample = (at: string, account = 'acct-a') => ({ at, account, session: 's', window: 'five_hour', usedPercent: 3, costUsd: 1, weightedTokens: 10 });

  it('reads the account into clientInfo and the samples beside it, dropping a sample without an account', () => {
    write('a.json', {
      cwd: '/work/repo', contextTokens: 5, updatedAt: new Date().toISOString(), claudeAccount: 'acct-a', claudeProfile: 'work',
      usageSamples: [sample('2026-10-30T08:00:00Z'), { ...sample('2026-10-30T08:01:00Z'), account: '' }, 'junk'],
    });
    const report = readClaudeReport('/work/repo', Date.now(), root);
    expect(report?.context).toEqual({ contextTokens: 5, claudeAccount: 'acct-a', claudeProfile: 'work' });
    expect(report?.usageSamples).toEqual([sample('2026-10-30T08:00:00Z')]);
    expect(channelClientInfo(report!.context, 'host')).toMatchObject({ claudeAccount: 'acct-a', claudeProfile: 'work' });
    expect(channelClientInfo(report!.context, 'host')).not.toHaveProperty('usageSamples');
  });

  it('sends a sample once: the next beat carries only the newer ones, also across Go fractional-second stamps', () => {
    const samples = [sample('2026-10-30T08:00:00Z'), sample('2026-10-30T08:00:00.5Z'), sample('2026-10-30T08:01:00Z')];
    expect(unsentSamples(samples, null)).toHaveLength(3);
    const sent = newestSample(samples.slice(0, 2), null);
    expect(unsentSamples(samples, sent).map((s) => s.at)).toEqual(['2026-10-30T08:01:00Z']);
    expect(newestSample([], sent)).toBe(sent);
  });
});

describe('ORB-2149 - the report directory', () => {
  it('lives under the orboto state directory of the user', () => {
    expect(claudeContextDir().endsWith(path.join('.orboto', 'claude-context'))).toBe(true);
  });
});

describe('ORB-2465 - the channel heartbeat names its host', () => {
  it('sends the lower-cased host next to the channel and the context report', () => {
    expect(channelClientInfo({ contextTokens: 10 }, ' Build-Host-A ')).toEqual({ channel: 'claude-code', host: 'build-host-a', contextTokens: 10 });
    expect(channelClientInfo(null, '')).toEqual({ channel: 'claude-code' });
  });
});
