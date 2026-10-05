import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OrbotoClient } from '../orboto-client.js';
import { selectComments, shortenComment, type ThreadComment } from './comment-thread.js';
import { makeGetTicketHandler } from './get-ticket.js';

beforeEach(() => { vi.restoreAllMocks(); });
afterEach(() => { vi.restoreAllMocks(); });

const words = (label: string, n: number) => Array.from({ length: n }, (_, i) => `${label}${String(i).padStart(2, '0')}`).join(' ');

function thread(bodies: string[]): ThreadComment[] {
  return bodies.map((content, i) => ({
    id: `0000000${i + 1}-aaaa-4000-8000-00000000000${i}`,
    content,
    createdAt: `2026-09-${String(i + 1).padStart(2, '0')}`,
    userName: 'Ada',
    isInternal: false,
  }));
}

describe('ORB-2484 shortened comment thread', () => {
  it('lists newest first, the 3 newest in full and older ones shortened', () => {
    const { shown } = selectComments(thread([words('old', 120), 'b', 'c', 'd', 'e']), {});
    expect(shown.map((s) => s.row.content.slice(0, 3))).toEqual(['e', 'd', 'c', 'b', 'old']);
    expect(shown[3]!.rest).toBe(0);
    expect(shown[4]!.rest).toBeGreaterThan(0);
    expect(Array.from(shown[4]!.excerpt).length).toBeLessThanOrEqual(300);
  });

  it('full keeps every body, commentId selects one by id or 8-character prefix', () => {
    const t = thread([words('old', 120), 'b', 'c', 'd']);
    expect(selectComments(t, { full: true }).shown.every((s) => s.rest === 0)).toBe(true);
    const byPrefix = selectComments(t, { commentId: '00000001' });
    expect(byPrefix.shown).toHaveLength(1);
    expect(byPrefix.shown[0]!.rest).toBe(0);
    expect(selectComments(t, { commentId: t[1]!.id }).shown[0]!.row.content).toBe('b');
    expect(selectComments(t, { commentId: '99999999' }).error).toMatch(/No comment with id/);
    expect(selectComments(t, { commentId: '0000' }).error).toMatch(/at least 8/);
    const twins = [{ ...t[0]!, id: 'abcdef01-1' }, { ...t[1]!, id: 'abcdef01-2' }];
    expect(selectComments(twins, { commentId: 'abcdef01' }).error).toMatch(/matches 2 comments/);
  });

  it('cuts at a word boundary and never inside a multi-byte character', () => {
    const cut = shortenComment(`${'x'.repeat(295)} ${'y'.repeat(40)}`, 300);
    expect(cut.excerpt).toBe('x'.repeat(295));
    const umlauts = shortenComment('ä'.repeat(500), 300);
    expect(Array.from(umlauts.excerpt)).toHaveLength(300);
    expect(umlauts.rest).toBe(200);
    expect(shortenComment('short', 300)).toEqual({ excerpt: 'short', rest: 0 });
  });

  it('orboto_get_ticket prints the shortened thread with the pointer and honours commentId', async () => {
    const rows = thread([words('old', 120), 'b', 'c', 'd']);
    const client = new OrbotoClient({ baseUrl: 'https://orboto.example.com', apiKey: 'orb_x' });
    const route = (url: string): unknown => {
      if (url.includes('/comments')) return { items: rows, nextCursor: null };
      if (url.includes('/tickets?parentTicketId')) return { items: [], nextCursor: null };
      if (url.endsWith('/attachments')) return [];
      if (url.includes('/projects/by-key/')) return { id: 'p1', key: 'ACME' };
      return { id: 't1', projectId: 'p1', ticketKey: 'ACME-6', title: 'X', status: 'TODO', statusName: 'To Do', type: 'task', priority: 'normal', commentCount: 4 };
    };
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => ({
      ok: true, status: 200, statusText: 'OK', json: async () => route(url.toString()), text: async () => '',
    }) as unknown as Response);
    const res = await makeGetTicketHandler(client)({ ticketKey: 'ACME-6', include: ['comments'] });
    const text = (res.content[0] as { text: string }).text;
    expect(text).toContain('## Comments (4, newest first; the 3 newest in full, full: true prints all)');
    expect(text).toContain('more characters: orboto_get_ticket { ticketKey: "ACME-6", commentId: "00000001-aaaa-4000-8000-000000000000" }');
    expect(text).not.toContain('old119');
    const one = await makeGetTicketHandler(client)({ ticketKey: 'ACME-6', commentId: '00000001' });
    expect((one.content[0] as { text: string }).text).toContain('old119');
    const missing = await makeGetTicketHandler(client)({ ticketKey: 'ACME-6', commentId: 'ffffffff' });
    expect(missing.isError).toBe(true);
  });
});
