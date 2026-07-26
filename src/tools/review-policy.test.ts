/**
 * ORB-1615 - `orboto_review_fingerprint` / `orboto_review_policy_check` /
 * `orboto_review_approval_record` unit tests.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OrbotoClient } from '../orboto-client.js';
import {
  makeReviewFingerprintHandler,
  makeReviewPolicyCheckHandler,
  makeReviewApprovalRecordHandler,
} from './review-policy.js';

beforeEach(() => { vi.restoreAllMocks(); });
afterEach(() => { vi.restoreAllMocks(); });

function stub(responses: Array<{ ok?: boolean; status?: number; json?: unknown }>) {
  const calls: Array<{ url: string; method: string; body?: unknown }> = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    calls.push({ url: url.toString(), method: init?.method ?? 'GET', body: init?.body ? JSON.parse(init.body as string) : undefined });
    const r = responses.shift();
    if (!r) throw new Error(`unexpected extra fetch ${init?.method ?? 'GET'} ${url}`);
    return { ok: r.ok ?? true, status: r.status ?? 200, statusText: 'OK', json: async () => ('json' in r ? r.json : {}), text: async () => '' } as unknown as Response;
  });
  return calls;
}

const client = new OrbotoClient({ baseUrl: 'https://orboto.example.com', apiKey: 'orb_x' });
const PROJ = { id: 'p1', key: 'ACME', name: 'Acme', description: null, status: 'active' };
const TICKET = { id: 't1', projectId: 'p1', ticketKey: 'ACME-1', ticketNumber: 1, title: 'Bug', description: null, status: 'IN_PROGRESS', statusName: 'In Progress', statusCategory: 'in_progress', type: 'bug', priority: 'normal', estimatedTimeMinutes: 0, dueDate: null, isPrivate: false };

describe('orboto_review_fingerprint', () => {
  it('computes a fingerprint + size metrics from raw diff text', async () => {
    const calls = stub([{ json: { fingerprint: 'abc123', algo: 'sha256-diff-v1', filesChanged: 1, linesAdded: 1, linesRemoved: 1, paths: ['src/foo.ts'] } }]);
    const res = await makeReviewFingerprintHandler(client)({ diff: 'diff --git a/src/foo.ts b/src/foo.ts\n-a\n+b\n' });
    expect(calls[0].url).toContain('/review-policy/fingerprint');
    expect(calls[0].method).toBe('POST');
    expect(res.structuredContent?.fingerprint).toBe('abc123');
    expect((res.content[0] as { text: string }).text).toContain('abc123');
  });
});

describe('orboto_review_policy_check', () => {
  it('reports the resolved risk level and whether a valid approval exists', async () => {
    const decision = {
      riskLevel: 'required', source: 'rule', matchedRuleName: 'api routes', evaluationError: null,
      fingerprintChecked: true, hasValidApproval: false, latestApproval: null,
    };
    const calls = stub([{ json: PROJ }, { json: TICKET }, { json: decision }]);
    const res = await makeReviewPolicyCheckHandler(client)({ ticketKey: 'ACME-1', fingerprint: 'abc123' });
    const check = calls.find((c) => c.method === 'POST');
    expect(check?.url).toContain('/projects/p1/tickets/t1/review-policy/check');
    expect(check?.body).toMatchObject({ fingerprint: 'abc123' });
    expect(res.structuredContent).toMatchObject({ riskLevel: 'required', hasValidApproval: false });
    expect((res.content[0] as { text: string }).text).toContain('required');
    expect((res.content[0] as { text: string }).text).toContain('No valid approval');
  });

  it('surfaces the fail-safe direction distinctly when the policy engine errored', async () => {
    const decision = {
      riskLevel: 'required', source: 'fail_safe', matchedRuleName: null, evaluationError: 'db timeout',
      fingerprintChecked: false, hasValidApproval: false, latestApproval: null,
    };
    stub([{ json: PROJ }, { json: TICKET }, { json: decision }]);
    const res = await makeReviewPolicyCheckHandler(client)({ ticketKey: 'ACME-1' });
    expect((res.content[0] as { text: string }).text).toContain('treat as required');
  });
});

describe('orboto_review_approval_record', () => {
  it('records an approval against a fingerprint', async () => {
    const approval = { id: 'ra1', ticketId: 't1', fingerprint: 'abc123', decision: 'approved', reviewerLabel: 'reviewer@orboto.test', note: null, revokedAt: null, createdAt: '2026-01-01T00:00:00Z' };
    const calls = stub([{ json: PROJ }, { json: TICKET }, { json: approval }]);
    const res = await makeReviewApprovalRecordHandler(client)({ ticketKey: 'ACME-1', fingerprint: 'abc123', decision: 'approved', note: 'looks good' });
    const record = calls.find((c) => c.method === 'POST' && c.url.includes('review-approvals'));
    expect(record?.body).toMatchObject({ fingerprint: 'abc123', decision: 'approved', note: 'looks good' });
    // ticketKey must NOT leak into the request body sent to the API - the
    // route resolves the ticket from the URL, not the payload.
    expect(record?.body).not.toHaveProperty('ticketKey');
    expect((res.content[0] as { text: string }).text).toContain('approved');
  });
});
