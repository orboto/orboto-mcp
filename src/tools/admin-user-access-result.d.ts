/** Mirrors AccessEmailResult and AccessEmailBulkResponse of @orboto/shared-schema; the MCP package ships without them, apps/api/src/test/admin-user-access-mcp-drift.test.ts pins the copy in both directions. */
export interface AccessEmailResult {
  userId: string;
  email: string | null;
  status: 'sent' | 'not_sent' | 'skipped';
  reason?: 'not_found' | 'bot' | 'inactive' | 'placeholder' | 'federated_ghost' | 'cooldown' | 'beyond_authority' | 'error' | 'account_changed' | 'needs_person' | undefined;
  retryAfterSeconds?: number | undefined;
  linkIncluded: boolean;
  expiresAt: string | null;
  ssoProvider: string | null;
  resetUrl?: string | undefined;
}

export interface AccessEmailBulkResponse {
  results: AccessEmailResult[];
  sent: number;
  notSent: number;
  skipped: number;
}
