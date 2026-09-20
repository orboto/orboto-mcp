/**
 * ORB-1693 - the agent-facing projection of a duplicate-warning entry.
 */

export interface RichSimilarEntry {
  id: string;
  ticketKey: string | null;
  title: string;
  statusCategory: string | null;
  similarity: number;
  matchMode?: 'tsvector' | 'embedding';
  /** ORB-1604 - parent/sibling/epic context marker; absent on older responses. */
  relation?: string | null;
}

export interface AgentSimilarEntry {
  ticketKey: string;
  title: string;
  statusCategory: string | null;
  /** ORB-2185 - null for a full-text candidate: its rank is relative, not a similarity. */
  similarity: number | null;
  matchMode: 'tsvector' | 'embedding';
  relation: string | null;
}

export function trimSimilarEntry(w: RichSimilarEntry): AgentSimilarEntry {
  const matchMode = w.matchMode ?? 'embedding';
  return {
    ticketKey: w.ticketKey ?? w.id.slice(0, 8),
    title: w.title,
    statusCategory: w.statusCategory ?? null,
    similarity: matchMode === 'embedding' ? Math.round(w.similarity * 100) / 100 : null,
    matchMode,
    relation: w.relation ?? null,
  };
}

export function trimSimilarEntries(list: RichSimilarEntry[] | undefined | null): AgentSimilarEntry[] {
  return (list ?? []).map(trimSimilarEntry);
}
