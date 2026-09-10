/**
 * ORB-1693 - the agent-facing projection of a duplicate-warning entry.
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
