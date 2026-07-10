import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { OrbotoClient } from '../orboto-client.js';
import { makeCriticalPathHandler } from './critical-path.js';

beforeEach(() => { vi.restoreAllMocks(); });
afterEach(() => { vi.restoreAllMocks(); });

function stub(responses: Array<{ json?: unknown }>) {
  const calls: string[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
    calls.push(url.toString());
    const r = responses.shift();
    if (!r) throw new Error(`unexpected extra fetch to ${url}`);
    return { ok: true, status: 200, statusText: 'OK', json: async () => ('json' in r ? r.json : {}), text: async () => '' } as unknown as Response;
  });
  return calls;
}

const client = new OrbotoClient({ baseUrl: 'https://orboto.example.com', apiKey: 'orb_x' });
const PROJ = { id: 'p1', key: 'ACME', name: 'Acme', description: '', status: 'active' };

describe('orboto_critical_path (ORB-1028)', () => {
  it('resolves the project and returns the path + per-ticket float', async () => {
    const calls = stub([
      { json: PROJ },
      { json: {
        tickets: [
          { ticketKey: 'ACME-1', title: 'A', durationDays: 1, totalFloat: 0, isCritical: true },
          { ticketKey: 'ACME-2', title: 'B', durationDays: 1, totalFloat: 2, isCritical: false },
        ],
        criticalPath: ['ACME-1'],
        dependencies: [],
        projectDurationDays: 1,
        cycle: null,
      } },
    ]);
    const res = await makeCriticalPathHandler(client)({ projectKey: 'ACME' });
    expect(calls[1]).toContain('/projects/p1/critical-path');
    expect(calls[1]).not.toContain('milestoneId');
    const sc = res.structuredContent as { criticalPath: string[]; tickets: Array<{ ticketKey: string; isCritical: boolean; totalFloat: number }> };
    expect(sc.criticalPath).toEqual(['ACME-1']);
    expect(sc.tickets.find((t) => t.ticketKey === 'ACME-2')).toMatchObject({ isCritical: false, totalFloat: 2 });
    expect((res.content[0] as { text: string }).text).toContain('ACME-1');
  });

  it('resolves a milestone name to its id query param', async () => {
    const calls = stub([
      { json: PROJ },
      { json: [{ id: 'm2', name: 'Sprint 7' }] },
      { json: { tickets: [], criticalPath: [], dependencies: [], projectDurationDays: 0, cycle: null } },
    ]);
    await makeCriticalPathHandler(client)({ projectKey: 'ACME', milestone: 'Sprint 7' });
    expect(calls[2]).toContain('milestoneId=m2');
  });

  it('surfaces deadline risks (negative float) in text + structured output', async () => {
    const calls = stub([
      { json: PROJ },
      { json: {
        tickets: [
          { ticketKey: 'ACME-1', title: 'A', durationDays: 3, totalFloat: -2, isCritical: true, deadlineCritical: true, bindingConstraint: 'successors' },
          { ticketKey: 'ACME-2', title: 'B', durationDays: 2, totalFloat: -2, isCritical: true, deadlineCritical: true, bindingConstraint: 'due_date' },
        ],
        criticalPath: ['ACME-1', 'ACME-2'],
        deadlineRisks: [
          { ticketKey: 'ACME-1', constrainingTicketKey: 'ACME-2', dueDate: '2026-07-18', shortfallDays: 2 },
          { ticketKey: 'ACME-2', constrainingTicketKey: 'ACME-2', dueDate: '2026-07-18', shortfallDays: 2 },
        ],
        dependencies: [],
        projectDurationDays: 5,
        cycle: null,
      } },
    ]);
    const res = await makeCriticalPathHandler(client)({ projectKey: 'ACME' });
    expect(calls[1]).toContain('/projects/p1/critical-path');
    const text = (res.content[0] as { text: string }).text;
    expect(text).toMatch(/DEADLINE RISKS/);
    expect(text).toContain('ACME-2: 2d short');
    const sc = res.structuredContent as { deadlineRisks: Array<{ ticketKey: string; shortfallDays: number }> };
    expect(sc.deadlineRisks).toHaveLength(2);
    expect(sc.deadlineRisks[0]).toMatchObject({ ticketKey: 'ACME-1', shortfallDays: 2 });
  });

  it('surfaces a dependency cycle', async () => {
    stub([
      { json: PROJ },
      { json: { tickets: [], criticalPath: [], dependencies: [], projectDurationDays: 0, cycle: { ticketKeys: ['ACME-1', 'ACME-2'] } } },
    ]);
    const res = await makeCriticalPathHandler(client)({ projectKey: 'ACME' });
    expect((res.content[0] as { text: string }).text).toMatch(/cycle/i);
    expect((res.structuredContent as { cycle: { ticketKeys: string[] } }).cycle.ticketKeys).toEqual(['ACME-1', 'ACME-2']);
  });
});
