import { describe, expect, it, vi } from 'vitest';
import type { OrbotoClient } from '../orboto-client.js';
import { laneRereviewToolConfig, makeLaneRereviewHandler } from './lane-rereview.js';

const laneId = '11111111-1111-4111-8111-111111111111';
const task = { id: '44444444-4444-4444-8444-444444444444', ticketKey: 'ACME-7', state: 'queued', reviewRound: 1 };

function client() {
  const get = vi.fn(async (path: string) => {
    if (path === '/admin/agent-lanes') return { items: [{ id: laneId, name: 'review-1' }] };
    if (path === '/projects/by-key/ACME') return { id: 'p1', key: 'ACME' };
    if (path === '/projects/p1/tickets/by-key/7') return { id: 't1', ticketKey: 'ACME-7' };
    throw new Error(`unexpected GET ${path}`);
  });
  const post = vi.fn().mockResolvedValue(task);
  return { get, post, client: { get, post } as unknown as OrbotoClient };
}

describe('ORB-2819 orboto_lane_rereview', () => {
  it('is a non-destructive write with a title', () => {
    expect(laneRereviewToolConfig.title).toBe('Request another lane review');
    expect(laneRereviewToolConfig.annotations).toEqual({ readOnlyHint: false, destructiveHint: false, idempotentHint: false });
  });

  it('resolves the lane by name and the ticket by key, then posts the request with a fresh key', async () => {
    const c = client();
    const result = await makeLaneRereviewHandler(c.client)({ lane: 'review-1', ticketKey: 'ACME-7', reason: ' Criteria changed ' });
    expect(c.post).toHaveBeenCalledWith(`/agent-lanes/${laneId}/tasks/rereview`, { ticketId: 't1', reason: 'Criteria changed', idempotencyKey: expect.stringMatching(/^[0-9a-f-]{36}$/) });
    expect((result.content[0] as { text: string }).text).toBe(`Review task ${task.id} for ACME-7: queued, round 1.`);
    expect(result.structuredContent).toMatchObject({ reviewRound: 1 });
  });

  it('takes a lane UUID without listing lanes and refuses an unknown lane name', async () => {
    const c = client();
    await makeLaneRereviewHandler(c.client)({ lane: laneId, ticketKey: 'ACME-7', reason: 'Again' });
    expect(c.get).not.toHaveBeenCalledWith('/admin/agent-lanes');
    await expect(makeLaneRereviewHandler(c.client)({ lane: 'ghost', ticketKey: 'ACME-7', reason: 'Again' })).rejects.toThrow('No agent lane named "ghost"');
  });
});
