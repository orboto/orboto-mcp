/** Mirrors ImportCharRefsReport and ImportCharRefsRepairResponse of @orboto/shared-schema; the MCP package ships without them, apps/api/src/test/import-char-refs-mcp-drift.test.ts pins the copy in both directions. */
export type ImportCharRefsField = 'title' | 'description' | 'comment' | 'label' | 'milestone';

export interface ImportCharRefsFieldCounts {
  checked: number;
  repairable: number;
  replacementChar: number;
}

export interface ImportCharRefsReport {
  scope: 'job' | 'project';
  token: string | null;
  adapterId: string;
  status: string;
  projectId: string | null;
  importedAt: string | null;
  importedTickets: number | null;
  supported: boolean;
  tickets: number;
  unnumberedTickets: number;
  counts: {
    titles: ImportCharRefsFieldCounts; descriptions: ImportCharRefsFieldCounts; comments: ImportCharRefsFieldCounts; labels: ImportCharRefsFieldCounts;
    milestones: ImportCharRefsFieldCounts;
  };
  labelConflicts: number;
  milestoneConflicts: number;
  samples: Array<{ field: ImportCharRefsField; ticketKey: string | null; before: string; after: string }>;
  replacementCharRows: Array<{
    field: ImportCharRefsField; ticketId: string | null; ticketKey: string | null; commentId: string | null; labelId: string | null; milestoneId: string | null; excerpt: string;
  }>;
  replacementCharOmitted: number;
  manualRows: Array<{ kind: 'comment' | 'user'; ticketId: string | null; ticketKey: string | null; commentId: string | null; userId: string | null; excerpt: string }>;
  manualOmitted: number;
}

export interface ImportCharRefsRepairResponse {
  processedTickets: number;
  titles: number;
  descriptions: number;
  comments: number;
  labels: number;
  labelConflicts: number;
  milestones: number;
  milestoneConflicts: number;
  edited: number;
  replacementChar: number;
  next: number | null;
}
