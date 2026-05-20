/**
 * ORB-933 — tests for the PATCH-side MCP tools across the
 * absences / public-holidays / company-closures resources.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OrbotoApiError, OrbotoClient } from '../orboto-client.js';
import {
  makeUpdatePublicHolidayHandler,
  makeUpdateCompanyClosureHandler,
  makeUpdateAbsenceHandler,
} from './absence-writes.js';

beforeEach(() => { vi.restoreAllMocks(); });
afterEach(() => { vi.restoreAllMocks(); });

const client = new OrbotoClient({ baseUrl: 'https://orboto.example.com', apiKey: 'orb_x' });

const PH_ID = 'aaaaaaaa-0000-0000-0000-000000000001';
const CC_ID = 'bbbbbbbb-0000-0000-0000-000000000001';
const ABS_ID = 'cccccccc-0000-0000-0000-000000000001';

function stubJSON(responses: Array<{ ok?: boolean; status?: number; json?: unknown }>) {
  const calls: Array<{ url: string; method: string; body?: unknown }> = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    calls.push({
      url: url.toString(),
      method: init?.method ?? 'GET',
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body,
    });
    const r = responses.shift();
    if (!r) throw new Error('unexpected extra fetch');
    return {
      ok: r.ok ?? true,
      status: r.status ?? 200,
      statusText: 'OK',
      json: async () => ('json' in r ? r.json : {}),
      text: async () => '',
    } as unknown as Response;
  });
  return calls;
}

describe('orboto_update_public_holiday', () => {
  it('PATCHes only the supplied fields', async () => {
    const calls = stubJSON([{
      json: { id: PH_ID, name: 'Day of German Unity', date: '2026-10-03', countryCode: 'DE', regionCode: null, isRecurring: true },
    }]);
    const res = await makeUpdatePublicHolidayHandler(client)({ id: PH_ID, date: '2026-10-03' });
    expect(calls[0]).toMatchObject({
      method: 'PATCH',
      url: `https://orboto.example.com/admin/public-holidays/${PH_ID}`,
      body: { date: '2026-10-03' },
    });
    expect((res.structuredContent as { date: string }).date).toBe('2026-10-03');
  });

  it('bubbles up a 403 when caller lacks admin:absences:write', async () => {
    stubJSON([{ ok: false, status: 403, json: { error: 'Forbidden' } }]);
    await expect(
      makeUpdatePublicHolidayHandler(client)({ id: PH_ID, name: 'X' }),
    ).rejects.toBeInstanceOf(OrbotoApiError);
  });
});

describe('orboto_update_company_closure', () => {
  it('PATCHes the named fields only', async () => {
    const calls = stubJSON([{
      json: { id: CC_ID, name: 'Summer break', startDate: '2026-07-20', endDate: '2026-08-02', note: null },
    }]);
    const res = await makeUpdateCompanyClosureHandler(client)({ id: CC_ID, endDate: '2026-08-02' });
    expect(calls[0]).toMatchObject({
      method: 'PATCH',
      url: `https://orboto.example.com/admin/company-closures/${CC_ID}`,
      body: { endDate: '2026-08-02' },
    });
    expect((res.structuredContent as { endDate: string }).endDate).toBe('2026-08-02');
  });

  it('bubbles up a 400 when start > end after the partial patch', async () => {
    stubJSON([{ ok: false, status: 400, json: { error: 'Start date must be before end date' } }]);
    await expect(
      makeUpdateCompanyClosureHandler(client)({ id: CC_ID, startDate: '2026-09-01' }),
    ).rejects.toBeInstanceOf(OrbotoApiError);
  });
});

describe('orboto_update_absence', () => {
  it('PATCHes typeId + dates and surfaces the recomputed durationDays', async () => {
    const calls = stubJSON([{
      json: {
        id: ABS_ID,
        userId: 'u1',
        typeId: 'aaaaaaaa-1111-1111-1111-111111111111',
        startDate: '2026-08-01',
        endDate: '2026-08-07',
        durationDays: '5.0',
        status: 'pending',
        note: 'family trip',
      },
    }]);
    const res = await makeUpdateAbsenceHandler(client)({
      id: ABS_ID,
      startDate: '2026-08-01',
      endDate: '2026-08-07',
      note: 'family trip',
    });
    expect(calls[0]).toMatchObject({
      method: 'PATCH',
      url: `https://orboto.example.com/absences/${ABS_ID}`,
      body: { startDate: '2026-08-01', endDate: '2026-08-07', note: 'family trip' },
    });
    expect((res.structuredContent as { durationDays: string }).durationDays).toBe('5.0');
  });

  it('bubbles up a 400 when the absence is already approved (status-locked)', async () => {
    stubJSON([{ ok: false, status: 400, json: { error: 'Can only edit pending or draft absences' } }]);
    await expect(
      makeUpdateAbsenceHandler(client)({ id: ABS_ID, note: 'late change' }),
    ).rejects.toBeInstanceOf(OrbotoApiError);
  });

  it('bubbles up a 403 when caller is not the owner', async () => {
    stubJSON([{ ok: false, status: 403, json: { error: 'Forbidden' } }]);
    await expect(
      makeUpdateAbsenceHandler(client)({ id: ABS_ID, note: 'x' }),
    ).rejects.toBeInstanceOf(OrbotoApiError);
  });
});
