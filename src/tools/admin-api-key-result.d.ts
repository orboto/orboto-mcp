/** Mirrors AdminApiKeyRevokeResult of @orboto/shared-schema; the MCP package ships without it, apps/api/src/test/admin-api-key-revoke-mcp-drift.test.ts pins the copy in both directions. */
export interface AdminApiKeyRevokeResult {
  revoked: boolean;
  key: {
    id: string;
    name: string;
    keyPrefix: string;
    isAgent: boolean;
    userId: string;
    userName: string | null;
    userEmail: string | null;
    userIsBot: boolean;
    lastUsedAt: string | null;
    expiresAt: string | null;
    createdAt: string;
  };
}
