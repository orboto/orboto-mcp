/** Mirrors AiReviewerResolution of @orboto/shared-schema; the MCP package ships without it, apps/api/src/test/ai-reviewer-mcp-drift.test.ts pins the copy in both directions. */
export interface AiReviewerResolution {
  provider: string | null;
  catalogue: 'ranked' | 'unranked' | 'unavailable' | 'not_managed' | 'no_provider';
  operations: Array<{
    operation: string;
    suffix: string;
    enabled: boolean;
    generator: string | null;
    generatorRank: number | null;
    configured: string | null;
    configuredSource: 'operation' | 'workspace' | 'catalogue' | null;
    configuredRank: number | null;
    reviewer: string | null;
    reviewerRank: number | null;
    reason: 'configured' | 'raised' | 'different_model' | 'same_model' | 'unranked' | 'unverified' | null;
    weakerConfigured: boolean;
    warning: 'no_ranks' | 'generator_unranked' | 'reviewer_unranked' | null;
  }>;
}
