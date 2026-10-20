import { afterEach, describe, expect, it, vi } from 'vitest';
import { OrbotoClient } from '../orboto-client.js';
import { makeRuleProposalAcceptHandler, makeRuleProposalRejectHandler, makeRuleProposeHandler, makeRuleProposalsHandler } from './rule-proposals.js';

afterEach(() => { vi.restoreAllMocks(); });

function stub(responses: Array<{ status?: number; json?: unknown }>) {
  const calls: Array<{ url: string; method: string; body?: unknown }> = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    calls.push({ url: url.toString(), method: init?.method ?? 'GET', body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined });
    const r = responses.shift();
    if (!r) throw new Error('unexpected extra fetch');
    const status = r.status ?? 200;
    return { ok: status < 400, status, statusText: 'x', json: async () => r.json, text: async () => JSON.stringify(r.json) } as unknown as Response;
  });
  return calls;
}

const client = new OrbotoClient({ baseUrl: 'https://orboto.example.com', apiKey: 'orb_x' });
const ROW = {
  id: '11111111-1111-1111-1111-111111111111', scope: 'project', projectKey: 'ORB', title: 'Run the gates one by one', status: 'pending',
  duplicates: [{ kind: 'rule', id: '22222222-2222-2222-2222-222222222222', title: 'Gates run separately', exact: false }],
  proposedByName: 'Claude Agent', decisionReason: null, canDecide: false,
};

describe('rule proposal MCP tools (ORB-2579)', () => {
  it('propose posts the proposal with the workspace default and names the text matches', async () => {
    const calls = stub([{ status: 201, json: ROW }]);
    const res = await makeRuleProposeHandler(client)({ title: ROW.title, body: 'Rule: one gate per call.', projectKey: 'ORB', scope: 'project', reason: 'a chained call ran one gate' });
    expect(calls[0]).toMatchObject({ method: 'POST', url: 'https://orboto.example.com/agent-instructions/proposals' });
    expect(calls[0]!.body).toEqual({ title: ROW.title, body: 'Rule: one gate per call.', projectKey: 'ORB', scope: 'project', reason: 'a chained call ran one gate' });
    const text = (res.content[0] as { text: string }).text;
    expect(text).toContain('pending review by a person with rule rights');
    expect(text).toContain('text match: rule "Gates run separately"');
    expect(text).not.toMatch(/%/);

    const calls2 = stub([{ status: 201, json: { ...ROW, scope: 'workspace', projectKey: null, duplicates: [] } }]);
    await makeRuleProposeHandler(client)({ title: 'x', body: 'y' });
    expect(calls2[0]!.body).toEqual({ title: 'x', body: 'y', scope: 'workspace' });
  });

  it('propose turns the hard-cap refusal into a blocked result', async () => {
    stub([{ status: 422, json: { error: 'too long', errorKey: 'errors.agent_content.oversize', sizeWarning: { chars: 900, limit: 800, hint: 'shorten it' } } }]);
    const res = await makeRuleProposeHandler(client)({ title: 'x', body: 'y'.repeat(900) });
    expect(res.isError).toBe(true);
    expect((res.content[0] as { text: string }).text).toContain('Rule proposal blocked');
  });

  it('list sends status, mine and cursor and marks what the caller can decide', async () => {
    const calls = stub([{ json: { items: [{ ...ROW, canDecide: true }], nextCursor: 'abc' } }]);
    const res = await makeRuleProposalsHandler(client)({ status: 'all', mine: true, cursor: 'c1' });
    expect(calls[0]!.url).toBe('https://orboto.example.com/agent-instructions/proposals?status=all&mine=true&cursor=c1');
    const text = (res.content[0] as { text: string }).text;
    expect(text).toContain('[pending] Run the gates one by one (project ORB');
    expect(text).toContain('[you can decide]');
    expect(text).toContain('More: cursor abc');
  });

  it('list defaults to the pending queue and says when it is empty', async () => {
    const calls = stub([{ json: { items: [], nextCursor: null } }]);
    const res = await makeRuleProposalsHandler(client)();
    expect(calls[0]!.url).toBe('https://orboto.example.com/agent-instructions/proposals?status=pending');
    expect((res.content[0] as { text: string }).text).toBe('No rule proposals.');
  });

  it('list forwards the scope, project, customer and limit filters', async () => {
    const calls = stub([{ json: { items: [], nextCursor: null } }]);
    await makeRuleProposalsHandler(client)({ scope: 'project', projectId: '44444444-4444-4444-8444-444444444444', customerId: '55555555-5555-4555-8555-555555555555', limit: 10 });
    expect(calls[0]!.url).toBe('https://orboto.example.com/agent-instructions/proposals?status=pending&scope=project&projectId=44444444-4444-4444-8444-444444444444&customerId=55555555-5555-4555-8555-555555555555&limit=10');
  });

  it('accept posts the edits and names the new block', async () => {
    const calls = stub([{ json: { proposal: { ...ROW, status: 'accepted', acceptedEdited: true }, block: { id: 'b1' }, proposerNotified: true } }]);
    const res = await makeRuleProposalAcceptHandler(client)({ proposalId: ROW.id, title: 'Short', mustRead: true, note: 'tightened' });
    expect(calls[0]).toMatchObject({ method: 'POST', url: `https://orboto.example.com/agent-instructions/proposals/${ROW.id}/accept`, body: { title: 'Short', mustRead: true, note: 'tightened' } });
    expect((res.content[0] as { text: string }).text).toBe(`Accepted rule proposal "${ROW.title}" as rule block b1 (edited); the proposer got the decision as agent mail.`);
  });

  it('accept surfaces the person-only refusal and the hard-cap block', async () => {
    stub([{ status: 403, json: { error: 'A person with rule rights decides on a rule proposal', errorKey: 'errors.agent_rules.review_needs_person' } }]);
    await expect(makeRuleProposalAcceptHandler(client)({ proposalId: ROW.id })).rejects.toThrow(/403/);
    stub([{ status: 422, json: { error: 'too long', sizeWarning: { chars: 900, limit: 800, hint: 'shorten it' } } }]);
    const blocked = await makeRuleProposalAcceptHandler(client)({ proposalId: ROW.id, body: 'x'.repeat(900) });
    expect(blocked.isError).toBe(true);
  });

  it('reject posts the reason', async () => {
    const calls = stub([{ json: { proposal: { ...ROW, status: 'rejected', decisionReason: 'covered' }, block: null, proposerNotified: false } }]);
    const res = await makeRuleProposalRejectHandler(client)({ proposalId: ROW.id, reason: 'covered' });
    expect(calls[0]).toMatchObject({ method: 'POST', url: `https://orboto.example.com/agent-instructions/proposals/${ROW.id}/reject`, body: { reason: 'covered' } });
    expect((res.content[0] as { text: string }).text).toBe(`Rejected rule proposal "${ROW.title}"; no agent mail was sent.`);
  });
});
