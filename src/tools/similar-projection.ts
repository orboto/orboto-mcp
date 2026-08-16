/**
 * ORB-1693 - the agent-facing projection of a duplicate-warning entry.
 *
 * Measured: `similarWarnings` was 76% of the entire create_ticket response
 * volume (~329k tokens over the corpus), and most of each entry was
 * decision-irrelevant: a CSS hex colour, a UUID next to the key, a
 * redundant statusName next to statusCategory, and similarity at 15
 * decimal places. The agent decision needs exactly:
 *
 *   { ticketKey, title, statusCategory, similarity (2dp), relation }
 *
 * The rich shape stays on the REST response for the web UI - this trims
 * only what agent surfaces emit. Same projection everywhere a warning
 * reaches an agent: create_ticket, the duplicate-block 409, check_similar
 * (mirrored in the chat registry + skill wrapper - keep them in sync).
 */

export interface RichSimilarEntry {
  id: string;
  ticketKey: string | null;
  title: string;
  statusCategory: string | null;
  similarity: number;
  /** ORB-1604 - parent/sibling/epic context marker; absent on older responses. */
  relation?: string | null;
}

export interface AgentSimilarEntry {
  ticketKey: string;
  title: string;
  statusCategory: string | null;
  similarity: number;
  relation: string | null;
}

export function trimSimilarEntry(w: RichSimilarEntry): AgentSimilarEntry {
  return {
    // Keys over UUIDs (repo rule); the short-id fallback only exists for
    // pre-backfill rows that never got a key.
    ticketKey: w.ticketKey ?? w.id.slice(0, 8),
    title: w.title,
    statusCategory: w.statusCategory ?? null,
    similarity: Math.round(w.similarity * 100) / 100,
    relation: w.relation ?? null,
  };
}

export function trimSimilarEntries(list: RichSimilarEntry[] | undefined | null): AgentSimilarEntry[] {
  return (list ?? []).map(trimSimilarEntry);
}
