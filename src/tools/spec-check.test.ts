import { afterEach, describe, expect, it, vi } from 'vitest';
import { OrbotoClient, OrbotoApiError } from '../orboto-client.js';
import { makeSpecCheckHandler, specCheckToolConfig } from './spec-check.js';

afterEach(() => { vi.restoreAllMocks(); });
describe('spec check', () => {
  it('returns the authoritative diagnostics and template without writes', async () => {
    const client = new OrbotoClient({ baseUrl: 'https://orboto.example.test', apiKey: 'test' });
    const report = { check: { valid: false, criteriaCount: 0, openQuestionCount: 2, missingHeadings: ['Goal'] }, template: 'template' };
    const get = vi.spyOn(client, 'get').mockResolvedValueOnce({ id: 'p', key: 'ORB' }).mockResolvedValueOnce({ id: 't', projectId: 'p' }).mockResolvedValueOnce(report);
    const post = vi.spyOn(client, 'post'); const patch = vi.spyOn(client, 'patch');
    expect(await makeSpecCheckHandler(client)({ ticketKey: 'ORB-2099' })).toMatchObject({ structuredContent: report });
    expect(get).toHaveBeenLastCalledWith('/projects/p/tickets/t/spec-check');
    expect(post).not.toHaveBeenCalled(); expect(patch).not.toHaveBeenCalled();
    expect(specCheckToolConfig.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
  });
  it('propagates read authorization errors', async () => {
    const client = new OrbotoClient({ baseUrl: 'https://orboto.example.test', apiKey: 'test' });
    vi.spyOn(client, 'get').mockResolvedValueOnce({ id: 'p', key: 'ORB' }).mockResolvedValueOnce({ id: 't', projectId: 'p' }).mockRejectedValueOnce(new OrbotoApiError(404, '{}', 'test'));
    await expect(makeSpecCheckHandler(client)({ ticketKey: 'ORB-2099' })).rejects.toMatchObject({ status: 404 });
  });
});
