import { OrbotoApiError, type OrbotoClient } from './orboto-client.js';

export interface RulesResponse {
  instructions?: string;
  requireSessionStart?: boolean;
  rulesHash: string;
  rulesUnchanged?: boolean;
  rulesIndex?: Array<{ title: string; chars: number }>;
  rulesChars?: number;
}

/** Fixed diagnostics only: neither rule text nor upstream bodies belong in logs. */
export class RequiredRulesError extends Error {
  readonly errorKey = 'errors.agent_rules.unavailable';
  constructor(readonly reason: 'invalid_response' | 'unbound_ack' | 'transport' | 'timeout' | 'http', readonly status?: number) {
    super(`Required agent rules could not be loaded (${reason}${status ? ` ${status}` : ''}). Do not proceed without the rules. Check connectivity and authentication, then retry session-start with forceRules.`);
    this.name = 'RequiredRulesError';
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Validate receipts before caching their hash or claiming delivery succeeded. */
export function validateRulesReceipt(value: unknown, knownHash?: string, textField: 'instructions' | 'rules' = 'instructions'): void {
  if (!record(value) || typeof value.rulesHash !== 'string' || !value.rulesHash
    || ('rulesUnchanged' in value && typeof value.rulesUnchanged !== 'boolean')) {
    throw new RequiredRulesError('invalid_response');
  }
  if (value.rulesUnchanged === true) {
    if (!knownHash || value.rulesHash !== knownHash) throw new RequiredRulesError('unbound_ack');
  } else if (typeof value[textField] !== 'string') {
    throw new RequiredRulesError('invalid_response');
  }
  if (('requireSessionStart' in value && typeof value.requireSessionStart !== 'boolean')
    || ('rulesChars' in value && (!Number.isInteger(value.rulesChars) || Number(value.rulesChars) < 0))
    || ('rulesIndex' in value && (!Array.isArray(value.rulesIndex) || value.rulesIndex.some((row) => !record(row)
      || typeof row.title !== 'string' || !Number.isInteger(row.chars) || Number(row.chars) < 0)))) {
    throw new RequiredRulesError('invalid_response');
  }
}

export function validateNextWorkEnvelope(value: unknown, peek = false): void {
  const integer = (n: unknown) => Number.isInteger(n) && Number(n) >= 0;
  const candidate = record(value) ? value.candidate : undefined;
  const hasCandidate = candidate !== undefined && candidate !== null;
  if (!record(value) || !('reserved' in value) || (value.reserved !== null && !record(value.reserved))
    || (peek && value.reserved !== null)
    || (hasCandidate && (!peek || value.reserved !== null || value.reason !== null
      || !record(candidate) || typeof candidate.ticketId !== 'string' || !candidate.ticketId
      || (candidate.ticketKey !== null && typeof candidate.ticketKey !== 'string')
      || typeof candidate.title !== 'string' || (candidate.priority !== null && typeof candidate.priority !== 'string')))
    || (value.reserved === null
      ? !hasCandidate && (typeof value.reason !== 'string' || !['all-blocked', 'all-leased', 'none-matching', 'autonomy_paused', 'lane_paused', 'lane_limit_reached'].includes(value.reason))
      : value.reason !== null)
    || !integer(value.candidatesConsidered)
    || (value.retryAfterSeconds !== null && !integer(value.retryAfterSeconds))
    || (value.earliestFreeAt !== null && typeof value.earliestFreeAt !== 'string')
    || !Array.isArray(value.landedIdle)
    || value.landedIdle.some((row) => !record(row) || typeof row.ticketId !== 'string' || !row.ticketId
      || (row.ticketKey !== null && typeof row.ticketKey !== 'string') || typeof row.title !== 'string'
      || typeof row.lastActivityAt !== 'string' || !integer(row.idleWorkingDays) || !integer(row.commitCount))) {
    throw new RequiredRulesError('invalid_response');
  }
}

/** One bounded, required read shared by session-start, resources and connect. */
export async function loadRequiredRules(client: OrbotoClient, path: string, knownHash?: string): Promise<RulesResponse> {
  let value: unknown;
  const controller = new AbortController();
  let deadline: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    deadline = setTimeout(() => {
      controller.abort();
      reject(new RequiredRulesError('timeout'));
    }, 10_000);
  });
  try {
    // Race the whole operation: OAuth token/keychain acquisition can stall
    // before fetch starts and therefore cannot observe fetch's abort signal.
    value = await Promise.race([client.get<unknown>(path, { signal: controller.signal }), timeout]);
  } catch (error) {
    if (error instanceof RequiredRulesError) throw error;
    if (error instanceof OrbotoApiError) throw new RequiredRulesError('http', error.status);
    if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) throw new RequiredRulesError('timeout');
    if (error instanceof SyntaxError) throw new RequiredRulesError('invalid_response');
    throw new RequiredRulesError('transport');
  } finally {
    clearTimeout(deadline);
  }
  validateRulesReceipt(value, knownHash);
  return value as RulesResponse;
}
