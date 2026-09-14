import { specReleaseInfo, type TicketRow } from './shared.js';
import { makeWorkSessionsHandler } from './work-sessions.js';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { OrbotoApiError, OrbotoClient } from '../orboto-client.js';
import { makeWorkStartHandler, makeWorkSessionStartHandler, workStartToolConfig } from './work-sessions.js';
import { makeClaimHandler } from './claim.js';
import { specGateFailure, TicketSpecStateSchema } from './spec-schemas.js';
import { updateProjectToolConfig } from './update-project.js';
import { makeAssignHandler, updateTicketToolConfig } from './ticket-writes.js';

afterEach(() => { vi.restoreAllMocks(); });

describe('spec readiness tool contracts', () => {
  it('keeps the isolated MCP state enum in sync with the API contract', () => {
    const canonical = readFileSync(path.resolve(process.cwd(), '../../packages/shared-schema/src/spec-readiness.ts'), 'utf8');
    const states = canonical.match(/TicketSpecStateSchema = z\.enum\(\[([^\]]+)\]/)?.[1].match(/'([^']+)'/g)?.map((value) => value.slice(1, -1));
    expect(states).toEqual(TicketSpecStateSchema.options);
  });

  it.each([makeWorkStartHandler, makeWorkSessionStartHandler])('forwards a reasoned override and explains the server gate', async (factory) => {
    const client = new OrbotoClient({ baseUrl: 'https://orboto.example.test', apiKey: 'test' });
    vi.spyOn(client, 'get').mockResolvedValueOnce({ id: 'project', key: 'ORB' }).mockResolvedValueOnce({ id: 'ticket', projectId: 'project' });
    const post = vi.spyOn(client, 'post').mockRejectedValue(new OrbotoApiError(409, JSON.stringify({ errorKey: 'errors.tickets.spec_not_ready', errorParams: { state: 'needs_spec' } }), 'test'));
    const result = await factory(client)({ ticketKey: 'ORB-2098', override: true, reason: 'Approved recovery' });
    expect(post.mock.calls[0][1]).toMatchObject({ ticketId: 'ticket', override: true, reason: 'Approved recovery' });
    expect(result).toMatchObject({ isError: true, structuredContent: { specGate: true, errorKey: 'errors.tickets.spec_not_ready', errorParams: { state: 'needs_spec' } } });
    expect(JSON.stringify(result.content)).toContain('release the specification');
  });

  it('stops a repeated sole claim at the gate before removing someone else', async () => {
    const client = new OrbotoClient({ baseUrl: 'https://orboto.example.test', apiKey: 'test' });
    vi.spyOn(client, 'get').mockResolvedValueOnce({ id: 'me' }).mockResolvedValueOnce({ id: 'project', key: 'ORB' }).mockResolvedValueOnce({ id: 'ticket', projectId: 'project', statusCategory: 'in_progress', assignees: [{ userId: 'me' }, { userId: 'other' }] });
    vi.spyOn(client, 'post').mockRejectedValue(new OrbotoApiError(409, '{"errorKey":"errors.tickets.spec_not_ready"}', 'test'));
    const remove = vi.spyOn(client, 'delete'); const patch = vi.spyOn(client, 'patch');
    expect(await makeClaimHandler(client)({ ticketKey: 'ORB-2098', sole: true })).toMatchObject({ isError: true, structuredContent: { specGate: true } });
    expect(remove).not.toHaveBeenCalled(); expect(patch).not.toHaveBeenCalled();
  });

  it.each([
    ['errors.tickets.already_assigned', true],
    ['errors.tickets.spec_not_ready', false],
    ['errors.work_sessions.lease_held', false],
  ])('only tolerates an already-assigned conflict: %s', async (errorKey, tolerated) => {
    for (const kind of ['claim', 'assign']) {
      const client = new OrbotoClient({ baseUrl: 'https://orboto.example.test', apiKey: 'test' });
      const get = vi.spyOn(client, 'get');
      if (kind === 'claim') get.mockResolvedValueOnce({ id: 'me' });
      get.mockResolvedValueOnce({ id: 'project', key: 'ORB' }).mockResolvedValueOnce({ id: 'ticket', projectId: 'project', statusCategory: 'in_progress', assignees: [{ userId: 'me' }] });
      if (kind === 'assign') get.mockResolvedValueOnce([{ userId: 'me', user: { id: 'me', email: 'me@spec.test' } }]);
      const error = new OrbotoApiError(409, JSON.stringify({ errorKey }), 'test');
      vi.spyOn(client, 'post').mockRejectedValue(error);
      const result = kind === 'claim' ? makeClaimHandler(client)({ ticketKey: 'ORB-2098', noTimer: true }) : makeAssignHandler(client)({ ticketKey: 'ORB-2098', assigneeEmail: 'me@spec.test' });
      if (tolerated) expect(await result).not.toHaveProperty('isError', true);
      else if (kind === 'claim' && errorKey === 'errors.tickets.spec_not_ready') expect(await result).toHaveProperty('isError', true);
      else await expect(result).rejects.toBe(error);
    }
  });

  it('exposes the settings, state and spec role and preserves unrelated conflict parsing', () => {
    expect(z.object(workStartToolConfig.inputSchema).parse({ ticketKey: 'ORB-2098', role: 'spec' }).role).toBe('spec');
    expect(z.object(updateTicketToolConfig.inputSchema).parse({ ticketKey: 'ORB-2098', patch: { specState: 'ready' } }).patch.specState).toBe('ready');
    expect(z.object(updateProjectToolConfig.inputSchema).parse({ projectKey: 'ORB', patch: { spec: { enabled: true, requiredTypes: ['story'], releaseBy: 'author' } } }).patch.spec?.releaseBy).toBe('author');
    expect(z.object(updateProjectToolConfig.inputSchema).parse({ projectKey: 'ORB', patch: { spec: { enabled: true } } }).patch.spec).toEqual({ enabled: true });
    expect(specGateFailure('not json')).toBeUndefined();
    expect(specGateFailure('{"errorKey":"errors.work_sessions.lease_held"}')).toBeUndefined();
    expect(JSON.stringify(specGateFailure('{"errorKey":"errors.tickets.epic_not_claimable"}'))).toContain('child stories');
  });
});


it('preserves release provenance without exposing the internal fingerprint', () => {
  const ticket = { specReleasedBy: 'author', specReleasedByFullName: 'Alice', specReleasedAt: '2026-09-14T10:00:00Z', specReleasePolicy: 'author', specReleaseRole: 'author', specReleaseFingerprint: 'internal-proof' } as unknown as TicketRow;
  expect(specReleaseInfo(ticket)).toEqual({ specReleasedBy: 'author', specReleasedByFullName: 'Alice', specReleasedAt: '2026-09-14T10:00:00Z', specReleasePolicy: 'author', specReleaseRole: 'author' });
});

it('describes waiting tasks as parked sessions and preserves the question reference', async () => {
  const client = new OrbotoClient({ baseUrl: 'https://orboto.example.test', apiKey: 'test' });
  const row = { id: 'session', ticketId: 'ticket', ticketKey: 'ORB-2100', role: 'spec', status: 'finished', waitingForAnswers: true, taskId: 'task', waitingCommentId: 'question', leaseUntil: 'past' };
  vi.spyOn(client, 'get').mockResolvedValue([row]);
  const result = await makeWorkSessionsHandler(client)({});
  expect(result.structuredContent).toEqual({ sessions: [row] });
  expect(JSON.stringify(result.content)).toContain('waiting for answers; session finished; task task; question question');
  expect(JSON.stringify(result.content)).not.toContain('lease until');
});
