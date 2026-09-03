/**
 * ORB-1826 - `resolveMilestoneByNameOrId` name-matching coverage.
 *
 * Production MCP error log: `Milestone "QA &amp; Testing" not found` for a
 * milestone literally named "QA & Testing" - the resolver did an exact,
 * case-sensitive `===` with no entity decode. "Normalise, never reject."
 */
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { OrbotoClient } from '../orboto-client.js';
import { resolveMilestoneByNameOrId } from './milestones.js';

beforeEach(() => { vi.restoreAllMocks(); });
afterEach(() => { vi.restoreAllMocks(); });

function mockMilestones(rows: Array<{ id: string; name: string; milestoneKey?: string | null }>) {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () => ({
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => rows,
    text: async () => JSON.stringify(rows),
  } as unknown as Response));
}

const client = new OrbotoClient({ baseUrl: 'https://orboto.example.com', apiKey: 'orb_x' });
const M1_UUID = '11111111-1111-1111-1111-111111111111';
const M2_UUID = '22222222-2222-2222-2222-222222222222';
const ROWS = [
  { id: M1_UUID, projectId: 'p1', name: 'QA & Testing', status: 'active', startDate: null, endDate: null, isPrivate: false, milestoneKey: 'ORB-M98' },
  { id: M2_UUID, projectId: 'p1', name: 'Launch Readiness', status: 'active', startDate: null, endDate: null, isPrivate: false, milestoneKey: 'ORB-M99' },
];

describe('resolveMilestoneByNameOrId', () => {
  it('resolves an already-clean exact name', async () => {
    mockMilestones(ROWS);
    const m = await resolveMilestoneByNameOrId(client, 'p1', 'QA & Testing');
    expect(m.id).toBe(M1_UUID);
  });

  it('resolves an HTML-entity-escaped name to the same milestone', async () => {
    mockMilestones(ROWS);
    const m = await resolveMilestoneByNameOrId(client, 'p1', 'QA &amp; Testing');
    expect(m.id).toBe(M1_UUID);
  });

  it('resolves case and whitespace variants', async () => {
    mockMilestones(ROWS);
    expect((await resolveMilestoneByNameOrId(client, 'p1', 'qa & testing')).id).toBe(M1_UUID);
    mockMilestones(ROWS);
    expect((await resolveMilestoneByNameOrId(client, 'p1', '  QA   &   Testing  ')).id).toBe(M1_UUID);
  });

  it('still resolves by key and by UUID', async () => {
    mockMilestones(ROWS);
    expect((await resolveMilestoneByNameOrId(client, 'p1', 'orb-m98')).id).toBe(M1_UUID);
    mockMilestones(ROWS);
    expect((await resolveMilestoneByNameOrId(client, 'p1', M2_UUID)).id).toBe(M2_UUID);
  });

  it('throws not-found for an unknown name', async () => {
    mockMilestones(ROWS);
    await expect(resolveMilestoneByNameOrId(client, 'p1', 'Nonexistent')).rejects.toThrow(/not found/);
  });

  it('throws ambiguous, listing candidates, when two names normalise to the same key', async () => {
    mockMilestones([...ROWS, { id: '33333333-3333-3333-3333-333333333333', name: 'qa &amp; testing' }]);
    await expect(resolveMilestoneByNameOrId(client, 'p1', 'QA &amp; Testing')).rejects.toThrow(/ambiguous/);
  });
});
