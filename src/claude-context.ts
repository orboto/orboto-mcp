/**
 * ORB-2149 - what a wake of this session costs. `orboto claude-statusline`
 * writes one file per Claude Code session; the proxy reports the freshest one
 * for its own directory. Two sessions in one directory, or none, report
 * nothing - the ledger then says "unknown", never an estimate.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

export const CLAUDE_CONTEXT_MAX_AGE_MS = 10 * 60_000;

export interface ClaudeContextReport {
  contextTokens: number;
  contextWindowSize?: number;
  /** ORB-2181 - the Claude Code session id the restart request file is keyed by. */
  sessionId?: string;
}

interface ContextFile {
  cwd?: unknown;
  sessionId?: unknown;
  contextTokens?: unknown;
  contextWindowSize?: unknown;
  updatedAt?: unknown;
}

export function claudeContextDir(): string {
  return path.join(homedir(), '.orboto', 'claude-context');
}

/** The one fresh report for `dir`; ambiguity and absence both mean "unknown". */
export function readClaudeContext(dir: string, now = Date.now(), root = claudeContextDir()): ClaudeContextReport | null {
  let names: string[];
  try {
    names = readdirSync(root).filter((n) => n.endsWith('.json'));
  } catch {
    return null;
  }
  const fresh: ClaudeContextReport[] = [];
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
      contextTokens: Math.max(0, Math.round(parsed.contextTokens)),
      ...(typeof parsed.contextWindowSize === 'number' && Number.isFinite(parsed.contextWindowSize)
        ? { contextWindowSize: Math.max(0, Math.round(parsed.contextWindowSize)) }
        : {}),
      ...(typeof parsed.sessionId === 'string' && parsed.sessionId ? { sessionId: parsed.sessionId } : {}),
    });
  }
  return fresh.length === 1 ? fresh[0] : null;
}
