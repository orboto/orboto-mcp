/**
 * ORB-2149 - what a wake of this session costs. `orboto claude-statusline`
 * writes one file per Claude Code session; the proxy reports the freshest one
 * for its own directory. Two sessions in one directory, or none, report
 * nothing - the ledger then says "unknown", never an estimate.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import path from 'node:path';

export const CLAUDE_CONTEXT_MAX_AGE_MS = 10 * 60_000;

export interface ClaudeContextReport {
  contextTokens: number;
  contextWindowSize?: number;
  /** ORB-2181 - the Claude Code session id the restart request file is keyed by. */
  sessionId?: string;
  /** ORB-2729 - the Claude account UUID and orboto profile the status line found. */
  claudeAccount?: string;
  claudeProfile?: string;
}

/** ORB-2729 - one usage sample the status line recorded; the heartbeat uploads the ones it has not sent yet. */
export interface ClaudeUsageSample {
  at: string;
  account: string;
  session: string;
  window: string;
  usedPercent: number;
  costUsd: number;
  weightedTokens: number;
  profile?: string;
  model?: string;
  resetsAt?: string;
}

interface ContextFile {
  cwd?: unknown;
  sessionId?: unknown;
  contextTokens?: unknown;
  contextWindowSize?: unknown;
  updatedAt?: unknown;
  claudeAccount?: unknown;
  claudeProfile?: unknown;
  usageSamples?: unknown;
}

const USAGE_SAMPLES_PER_BEAT = 50;

function usageSamplesOf(raw: unknown): ClaudeUsageSample[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((s): s is ClaudeUsageSample => Boolean(s) && typeof s === 'object'
    && typeof (s as ClaudeUsageSample).at === 'string' && typeof (s as ClaudeUsageSample).account === 'string' && (s as ClaudeUsageSample).account !== ''
    && typeof (s as ClaudeUsageSample).window === 'string' && typeof (s as ClaudeUsageSample).usedPercent === 'number')
    .slice(-USAGE_SAMPLES_PER_BEAT);
}

export function claudeContextDir(): string {
  return path.join(homedir(), '.orboto', 'claude-context');
}

/** The one fresh report for `dir`; ambiguity and absence both mean "unknown". */
export function readClaudeContext(dir: string, now = Date.now(), root = claudeContextDir()): ClaudeContextReport | null {
  return readClaudeReport(dir, now, root)?.context ?? null;
}

/** ORB-2729 - the fresh report for `dir` with the usage samples it carries, which travel beside clientInfo. */
export function readClaudeReport(dir: string, now = Date.now(), root = claudeContextDir()): { context: ClaudeContextReport; usageSamples: ClaudeUsageSample[] } | null {
  let names: string[];
  try {
    names = readdirSync(root).filter((n) => n.endsWith('.json'));
  } catch {
    return null;
  }
  const fresh: Array<{ context: ClaudeContextReport; usageSamples: ClaudeUsageSample[] }> = [];
  for (const name of names) {
    let parsed: ContextFile;
    try {
      parsed = JSON.parse(readFileSync(path.join(root, name), 'utf8')) as ContextFile;
    } catch {
      continue;
    }
    if (parsed.cwd !== dir) continue;
    const updated = typeof parsed.updatedAt === 'string' ? Date.parse(parsed.updatedAt) : NaN;
    if (!Number.isFinite(updated) || now - updated > CLAUDE_CONTEXT_MAX_AGE_MS) continue;
    if (typeof parsed.contextTokens !== 'number' || !Number.isFinite(parsed.contextTokens)) continue;
    fresh.push({
      context: {
        contextTokens: Math.max(0, Math.round(parsed.contextTokens)),
        ...(typeof parsed.contextWindowSize === 'number' && Number.isFinite(parsed.contextWindowSize)
          ? { contextWindowSize: Math.max(0, Math.round(parsed.contextWindowSize)) }
          : {}),
        ...(typeof parsed.sessionId === 'string' && parsed.sessionId ? { sessionId: parsed.sessionId } : {}),
        ...(typeof parsed.claudeAccount === 'string' && parsed.claudeAccount ? { claudeAccount: parsed.claudeAccount.slice(0, 64) } : {}),
        ...(typeof parsed.claudeProfile === 'string' && parsed.claudeProfile ? { claudeProfile: parsed.claudeProfile.slice(0, 64) } : {}),
      },
      usageSamples: usageSamplesOf(parsed.usageSamples),
    });
  }
  return fresh.length === 1 ? fresh[0] : null;
}

/** ORB-2729 - the samples newer than the last one the instance stored, so a beat never resends what it already delivered. */
export function unsentSamples(samples: ClaudeUsageSample[], sentUpTo: number | null): ClaudeUsageSample[] {
  return sentUpTo === null ? samples : samples.filter((s) => Date.parse(s.at) > sentUpTo);
}

/** The newest instant of the samples a beat delivered, the next beat's `sentUpTo`. */
export function newestSample(samples: ClaudeUsageSample[], previous: number | null): number | null {
  return samples.reduce<number | null>((max, s) => {
    const at = Date.parse(s.at);
    return Number.isFinite(at) && (max === null || at > max) ? at : max;
  }, previous);
}

/** ORB-2584 - the one heartbeat of a stdio server without a channel: its host and `toolServer`, so the API drops a `legacy` channel an older proxy of this row announced. */
export function toolServerHeartbeat(host: string = hostname()): Record<string, unknown> {
  const value = host.trim().toLowerCase().slice(0, 200);
  return { toolServer: true, ...(value ? { host: value } : {}) };
}

/** ORB-2465 - the channel heartbeat's clientInfo: the wake channel, the host `--host` filters on, and the context report; ORB-2584 - the start that delivers the channel. */
export function channelClientInfo(context: ClaudeContextReport | null, host: string = hostname(), start?: 'orboto-claude' | 'explicit' | 'legacy'): Record<string, unknown> {
  const value = host.trim().toLowerCase().slice(0, 200);
  return { channel: 'claude-code', ...(start ? { channelStart: start } : {}), ...(value ? { host: value } : {}), ...(context ?? {}) };
}
