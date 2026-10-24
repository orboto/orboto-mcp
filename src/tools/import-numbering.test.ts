/**
 * ORB-2676 - orboto_import_numbering and orboto_import_apply.
 */
import { describe, expect, it, vi } from 'vitest';
import { OrbotoApiError, type OrbotoClient } from '../orboto-client.js';
import { applyResponseBudget, budgetFor, measureHalves } from '../response-budget.js';
import { toolInToolset } from '../toolset.js';
import {
  makeImportApplyHandler,
  makeImportNumberingHandler,
  mergeRefusalOf,
  renumberedLine,
} from './import-numbering.js';

const TOKEN = '3f2b6c1e-8a4d-4e5f-9b7a-1c2d3e4f5a6b';
const PROJECT_ID = '9b7a1c2d-3e4f-4a6b-8c1d-2e3f4a5b6c7d';

const textOf = (result: { content: unknown[] }): string => (result.content[0] as { text: string }).text;

function ticket(n: number, reason: 'number_taken' | 'duplicate_source_number' = 'number_taken') {
  return {
    sourceId: `10${n}`,
    sourceKey: `PROJ-${n}`,
    sourceNumber: n,
    reason,
    existingTicketKey: reason === 'number_taken' ? `KEY-${n}` : null,
    existingTicketTitle: reason === 'number_taken' ? `Existing ticket number ${n}` : null,
    ticketNumber: 100 + n,
    ticketKey: `KEY-${100 + n}`,
  };
}

function plan(overrides: Record<string, unknown> = {}) {
  return {
    projectKey: 'KEY',
    sourceProjectKey: 'PROJ',
    projectKeyIssue: null,
    merge: true,
    existingTickets: 12,
    preserved: 40,
    withoutSourceNumber: 2,
    renumbered: [ticket(2), ticket(5, 'duplicate_source_number')],
    nextTicketNumber: 160,
    ...overrides,
  };
}

function refusal(overrides: Record<string, unknown> = {}) {
  const numbering = plan();
  return {
    error: 'This import merges into KEY',
    errorKey: 'errors.admin_import.merge_not_confirmed',
    errorParams: { projectKey: 'KEY', existingTickets: 12, renumbered: numbering.renumbered.length, missing: 'confirm_merge' },
    numbering,
    ...overrides,
  };
}

const conflict = (body: unknown) => new OrbotoApiError(409, typeof body === 'string' ? body : JSON.stringify(body), 'https://orboto.example.com/admin/import/jira/apply-async');

describe('orboto_import_numbering', () => {
  it('reads the numbering route with the project id and prints counts plus one line per renumbered ticket', async () => {
    const get = vi.fn().mockResolvedValue(plan());
    const result = await makeImportNumberingHandler({ get } as unknown as OrbotoClient)({ token: TOKEN, projectId: PROJECT_ID });
    expect(get).toHaveBeenCalledWith(`/admin/import/jobs/${TOKEN}/numbering?projectId=${PROJECT_ID}`);
    const text = textOf(result);
    expect(text).toContain('MERGE: KEY already has 12 tickets');
    expect(text).toContain('confirmProjectKey: "KEY" typed by the user');
    expect(text).toContain('Keep their source number: 40. No source number (fresh numbers after the highest): 2. Renumbered: 2. Next free number: 160.');
    expect(text).toContain('PROJ-2 -> KEY-102 (number_taken; KEY-2 "Existing ticket number 2")');
    expect(text).toContain('PROJ-5 -> KEY-105 (duplicate_source_number)');
    expect(result.structuredContent).toMatchObject({
      merge: true, existingTickets: 12, preserved: 40, renumberedTotal: 2, renumberedOmitted: 0,
      renumbered: [{ from: 'PROJ-2', to: 'KEY-102', reason: 'number_taken', existing: 'KEY-2' }, { from: 'PROJ-5', to: 'KEY-105', reason: 'duplicate_source_number' }],
    });
  });

  it('sends the proposed key of a new project, says it is no merge and names an unusable source key', async () => {
    const get = vi.fn().mockResolvedValue(plan({ merge: false, existingTickets: 0, renumbered: [], projectKey: 'NEWK', projectKeyIssue: 'taken' }));
    const result = await makeImportNumberingHandler({ get } as unknown as OrbotoClient)({ token: TOKEN, projectKey: 'NEWK' });
    expect(get).toHaveBeenCalledWith(`/admin/import/jobs/${TOKEN}/numbering?projectKey=NEWK`);
    expect(textOf(result)).toContain('Not a merge');
    expect(textOf(result)).toContain('cannot become the project key: another project holds it');
    expect(textOf(result)).not.toContain('Renumbered tickets');
  });

  it('falls back to a source number line for a ticket without a source key', () => {
    expect(renumberedLine({ ...ticket(7), sourceKey: null })).toBe('#7 -> KEY-107 (number_taken; KEY-7 "Existing ticket number 7")');
  });

  it('lists the first 30 renumbered tickets and says explicitly how many it left out, inside the default budget', async () => {
    const many = Array.from({ length: 2000 }, (_, i) => ticket(i + 1));
    const get = vi.fn().mockResolvedValue(plan({ renumbered: many }));
    const result = await makeImportNumberingHandler({ get } as unknown as OrbotoClient)({ token: TOKEN });
    expect(get).toHaveBeenCalledWith(`/admin/import/jobs/${TOKEN}/numbering?`);
    expect(textOf(result)).toContain('... 1970 more renumbered tickets not listed (2000 in all)');
    expect(textOf(result)).toContain(`orboto import numbering ${TOKEN}`);
    expect(result.structuredContent).toMatchObject({ renumberedTotal: 2000, renumberedOmitted: 1970 });
    expect((result.structuredContent as { renumbered: unknown[] }).renumbered).toHaveLength(30);
    const { textChars, structuredChars } = measureHalves(result);
    expect(Math.max(textChars, structuredChars)).toBeLessThanOrEqual(budgetFor('orboto_import_numbering', {}));
    const budgeted = applyResponseBudget('orboto_import_numbering', result, {});
    expect(budgeted.truncatedChars).toBe(0);
  });

  it('is cut explicitly by the central budget when the answer is still too long', () => {
    const long = Array.from({ length: 30 }, (_, i) => ({ ...ticket(i + 1), sourceKey: `PROJ-${'K'.repeat(400)}-${i}` }));
    const get = vi.fn().mockResolvedValue(plan({ renumbered: long }));
    return makeImportNumberingHandler({ get } as unknown as OrbotoClient)({ token: TOKEN }).then((result) => {
      const budgeted = applyResponseBudget('orboto_import_numbering', result, {});
      expect(budgeted.responseChars).toBeLessThanOrEqual(budgetFor('orboto_import_numbering', {}) + 700);
      expect(budgeted.handle).toBeTruthy();
    });
  });
});

describe('orboto_import_apply', () => {
  const mapping = { projectId: PROJECT_ID, statusMap: { Open: 'todo' } };

  it('queues the apply with the confirmations and the credentials only when given', async () => {
    const post = vi.fn().mockResolvedValue({ jobId: 'job-1', token: TOKEN, status: 'queued' });
    const handler = makeImportApplyHandler({ post } as unknown as OrbotoClient);

    const plain = await handler({ adapter: 'jira', stagingToken: TOKEN, mapping });
    expect(post).toHaveBeenLastCalledWith('/admin/import/jira/apply-async', { stagingToken: TOKEN, mapping });
    expect(textOf(plain)).toContain(`Import queued (job job-1, token ${TOKEN}`);
    expect(plain.structuredContent).toEqual({ applied: true, jobId: 'job-1', token: TOKEN, status: 'queued' });
    expect(plain.isError).toBeUndefined();

    await handler({
      adapter: 'jira', stagingToken: TOKEN, mapping, projectKey: 'NEWK', confirmMerge: true, confirmProjectKey: 'KEY', config: { baseUrl: 'https://jira.example.com', apiToken: 'secret' },
    });
    expect(post).toHaveBeenLastCalledWith('/admin/import/jira/apply-async', {
      stagingToken: TOKEN, mapping, projectKey: 'NEWK', confirmMerge: true, confirmProjectKey: 'KEY', config: { baseUrl: 'https://jira.example.com', apiToken: 'secret' },
    });
  });

  it('turns the 409 merge refusal into an error result that lists the collisions and asks the user for both confirmations', async () => {
    const post = vi.fn().mockRejectedValue(conflict(refusal()));
    const result = await makeImportApplyHandler({ post } as unknown as OrbotoClient)({ adapter: 'jira', stagingToken: TOKEN, mapping });
    expect(result.isError).toBe(true);
    const text = textOf(result);
    expect(text).toContain('NOT APPLIED');
    expect(text).toContain('merge into KEY, which already has 12 tickets; 2 imported tickets get a new number');
    expect(text).toContain('Missing first: the merge confirmation');
    expect(text).toContain('PROJ-2 -> KEY-102 (number_taken; KEY-2 "Existing ticket number 2")');
    expect(text).toContain('Ask them to confirm the merge AND to type the project key KEY themselves');
    expect(text).toContain('Never fill confirmMerge or confirmProjectKey on your own initiative');
    expect(result.structuredContent).toMatchObject({
      applied: false, refused: 'merge_not_confirmed', projectKey: 'KEY', existingTickets: 12, missing: 'confirm_merge', renumberedTotal: 2,
    });
  });

  it('names the typed project key as the missing confirmation when the merge was confirmed alone', async () => {
    const body = refusal({ errorParams: { projectKey: 'KEY', existingTickets: 12, renumbered: 2, missing: 'confirm_project_key' } });
    const post = vi.fn().mockRejectedValue(conflict(body));
    const result = await makeImportApplyHandler({ post } as unknown as OrbotoClient)({ adapter: 'jira', stagingToken: TOKEN, mapping, confirmMerge: true });
    expect(textOf(result)).toContain('Missing first: the typed project key');
    expect(result.structuredContent).toMatchObject({ missing: 'confirm_project_key' });
  });

  it('rethrows every other failure, including a 409 that is not the merge refusal', async () => {
    const handler = (err: unknown) => makeImportApplyHandler({ post: vi.fn().mockRejectedValue(err) } as unknown as OrbotoClient)({ adapter: 'jira', stagingToken: TOKEN, mapping });
    const forbidden = new OrbotoApiError(403, '{"error":"no"}', 'u');
    await expect(handler(forbidden)).rejects.toBe(forbidden);
    const other = conflict({ error: 'busy', errorKey: 'errors.system.import_already_running' });
    await expect(handler(other)).rejects.toBe(other);
    const garbled = conflict('not json');
    await expect(handler(garbled)).rejects.toBe(garbled);
    const plain = new Error('network');
    await expect(handler(plain)).rejects.toBe(plain);
  });

  it('recognises only the merge refusal with a numbering plan', () => {
    expect(mergeRefusalOf(conflict(refusal()))?.errorParams?.projectKey).toBe('KEY');
    expect(mergeRefusalOf(conflict({ errorKey: 'errors.admin_import.merge_not_confirmed' }))).toBeNull();
    expect(mergeRefusalOf(new OrbotoApiError(400, JSON.stringify(refusal()), 'u'))).toBeNull();
    expect(mergeRefusalOf(new Error('x'))).toBeNull();
  });
});

describe('toolsets', () => {
  it('keeps the two import tools out of the curated, minimal and channel sets', () => {
    for (const name of ['orboto_import_numbering', 'orboto_import_apply']) {
      expect(toolInToolset(name, 'full')).toBe(true);
      expect(toolInToolset(name, 'curated')).toBe(false);
      expect(toolInToolset(name, 'minimal')).toBe(false);
      expect(toolInToolset(name, 'channel')).toBe(false);
    }
  });
});
