/**
 * ORB-1223 - `orboto_list_approvals` / `orboto_approval_decide` unit tests.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OrbotoClient } from '../orboto-client.js';
import { makeListApprovalsHandler, makeApprovalDecideHandler } from './approvals.js';

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
const REQ = { id: 'r1', toStatusName: 'In Review', policyName: 'Sign-off', mode: 'any_n', status: 'pending', requiredApprovals: 1, currentStep: 0, approveCount: 0, rejectCount: 0, requestedBy: 'u9', canApprove: true, votes: [] };

describe('orboto_list_approvals', () => {
  it('lists a ticket\'s approval requests', async () => {
    stub([{ json: PROJ }, { json: TICKET }, { json: [REQ] }]);
    const res = await makeListApprovalsHandler(client)({ ticketKey: 'ACME-1' });
    expect(res.structuredContent?.requests).toHaveLength(1);
    expect((res.content[0] as { text: string }).text).toContain('In Review');
  });
});

describe('orboto_approval_decide', () => {
  it('approves the pending request the caller can vote on', async () => {
    const calls = stub([
      { json: PROJ }, { json: TICKET }, { json: [REQ] },
      { json: { ...REQ, status: 'approved', approveCount: 1 } },
    ]);
    const res = await makeApprovalDecideHandler(client)({ ticketKey: 'ACME-1', decision: 'approve' });
    const decide = calls.find((c) => c.method === 'POST');
    expect(decide?.url).toContain('/approval-requests/r1/decision');
    expect(decide?.body).toMatchObject({ decision: 'approve' });
    expect((res.content[0] as { text: string }).text).toContain('approved');
  });

  it('errors when no pending request exists', async () => {
    stub([{ json: PROJ }, { json: TICKET }, { json: [{ ...REQ, status: 'consumed' }] }]);
    await expect(makeApprovalDecideHandler(client)({ ticketKey: 'ACME-1', decision: 'approve' })).rejects.toThrow(/No pending approval/);
  });
});
