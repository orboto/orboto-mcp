import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { OrbotoClient } from '../orboto-client.js';
import { makeCustomerReportHandler } from './customer-report.js';

beforeEach(() => { vi.restoreAllMocks(); });
afterEach(() => { vi.restoreAllMocks(); });

function stub(responses: Array<{ json?: unknown; status?: number }>) {
  const calls: Array<{ url: string; body: unknown }> = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url: url.toString(), body });
    const r = responses.shift();
    if (!r) throw new Error(`unexpected extra fetch to ${url}`);
    const status = r.status ?? 200;
    return {
      ok: status < 400, status, statusText: 'OK',
      json: async () => ('json' in r ? r.json : {}), text: async () => '',
    } as unknown as Response;
  });
  return calls;
}

const client = new OrbotoClient({ baseUrl: 'https://orboto.example.com', apiKey: 'orb_x' });
const PROJ = { id: 'p1', key: 'ACME', name: 'Acme', description: '', status: 'active' };
const MD = {
  markdown: '# Project Report - Acme\n\n## Milestones\n',
  preset: 'scope', locale: 'de', priceMode: 'hours',
  aiSkipped: null,
  reviewFlags: { executiveSummaryGenerated: false, contentTranslated: false, translatedFields: 0 },
};

describe('orboto_customer_report (ORB-1383)', () => {
  it('resolves the project and posts a markdown generate with preset + locale', async () => {
    const calls = stub([{ json: PROJ }, { json: MD }]);
    const res = await makeCustomerReportHandler(client)({ projectKey: 'ACME', preset: 'scope', locale: 'de' });
    expect(calls[1].url).toContain('/projects/p1/customer-report/generate');
    expect(calls[1].body).toMatchObject({ preset: 'scope', locale: 'de', format: 'markdown' });
    expect((res.content[0] as { text: string }).text).toContain('Project Report');
    expect(res.structuredContent).toMatchObject({ projectKey: 'ACME', preset: 'scope', locale: 'de', aiSkipped: null });
  });

  it('passes lump-sum amount/currency in the options', async () => {
    const calls = stub([{ json: PROJ }, { json: { ...MD, priceMode: 'lumpSum' } }]);
    await makeCustomerReportHandler(client)({ projectKey: 'ACME', priceMode: 'lumpSum', lumpSumAmount: 5000, lumpSumCurrency: 'USD' });
    expect(calls[1].body).toMatchObject({ options: { priceMode: 'lumpSum', lumpSum: { amount: 5000, currency: 'USD' } } });
  });

  it('surfaces a budget:view 403 for money mode as a clean structured error', async () => {
    stub([{ json: PROJ }, { status: 403, json: { error: 'Forbidden' } }]);
    const res = await makeCustomerReportHandler(client)({ projectKey: 'ACME', priceMode: 'money' });
    expect((res.structuredContent as { requiredPermission: string }).requiredPermission).toBe('budget:view');
    expect((res.content[0] as { text: string }).text).toMatch(/budget:view/);
  });

  it('defaults to scope preset + hours mode', async () => {
    const calls = stub([{ json: PROJ }, { json: MD }]);
    await makeCustomerReportHandler(client)({ projectKey: 'ACME' });
    expect(calls[1].body).toMatchObject({ preset: 'scope', options: { priceMode: 'hours' } });
  });
});
