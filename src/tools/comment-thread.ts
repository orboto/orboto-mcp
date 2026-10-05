import type { OrbotoClient } from '../orboto-client.js';

/** ORB-2484 - the comment thread newest first, the newest few in full and older ones shortened. */

export const COMMENT_FULL_COUNT = 3;
export const COMMENT_EXCERPT_CHARS = 300;
const COMMENT_ID_MIN_PREFIX = 8;
const COMMENT_PAGE_SIZE = 50;
const COMMENT_MAX_PAGES = 20;

export interface ThreadComment {
  id: string;
  content: string;
  createdAt: string;
  editedAt?: string | null;
  userName?: string | null;
  isInternal?: boolean;
}

export interface ShownComment {
  row: ThreadComment;
  excerpt: string;
  length: number;
  rest: number;
}

/** Reads the whole thread, oldest first, across cursor pages. */
export async function fetchThread(client: OrbotoClient, ticketId: string): Promise<ThreadComment[]> {
  const out: ThreadComment[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < COMMENT_MAX_PAGES; page++) {
    const query: string = `limit=${COMMENT_PAGE_SIZE}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
    const res: { items: ThreadComment[]; nextCursor: string | null } = await client
      .get<{ items: ThreadComment[]; nextCursor: string | null }>(`/tickets/${ticketId}/comments?${query}`)
      .catch(() => ({ items: [], nextCursor: null }));
    out.push(...res.items);
    cursor = res.nextCursor;
    if (!cursor) break;
  }
  return out;
}

/** Cuts at a word boundary within max characters and reports how many characters it left out. */
export function shortenComment(content: string, max: number): { excerpt: string; rest: number } {
  const chars = Array.from(content);
  if (chars.length <= max) return { excerpt: content, rest: 0 };
  let end = max;
  if (!/\s/u.test(chars[max]!)) {
    for (let i = max - 1; i > 0; i--) {
      if (/\s/u.test(chars[i]!)) { end = i; break; }
    }
  }
  const excerpt = chars.slice(0, end).join('').trimEnd();
  return { excerpt, rest: chars.length - Array.from(excerpt).length };
}

/** Newest first; a commentId (full or an 8-character prefix) selects one comment in full. */
export function selectComments(
  thread: ThreadComment[],
  opts: { full?: boolean; commentId?: string },
): { shown: ShownComment[]; error?: string } {
  const entry = (row: ThreadComment, whole: boolean): ShownComment => {
    const length = Array.from(row.content).length;
    if (whole) return { row, excerpt: row.content, length, rest: 0 };
    return { row, length, ...shortenComment(row.content, COMMENT_EXCERPT_CHARS) };
  };
  if (opts.commentId) {
    const want = opts.commentId.trim().toLowerCase();
    const exact = thread.filter((c) => c.id.toLowerCase() === want);
    const hits = exact.length > 0 ? exact : want.length >= COMMENT_ID_MIN_PREFIX ? thread.filter((c) => c.id.toLowerCase().startsWith(want)) : [];
    if (hits.length === 0) return { shown: [], error: `No comment with id "${opts.commentId}" on this ticket (a prefix needs at least ${COMMENT_ID_MIN_PREFIX} characters).` };
    if (hits.length > 1) return { shown: [], error: `The id prefix "${opts.commentId}" matches ${hits.length} comments: ${hits.map((c) => c.id).join(', ')}.` };
    return { shown: [entry(hits[0]!, true)] };
  }
  const newestFirst = [...thread].reverse();
  return { shown: newestFirst.map((row, n) => entry(row, opts.full === true || n < COMMENT_FULL_COUNT)) };
}
