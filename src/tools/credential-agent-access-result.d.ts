/** Mirrors CredentialAgentAccess of @orboto/shared-schema; the MCP package ships without it, apps/api/src/test/credential-agent-access-mcp-drift.test.ts pins the copy in both directions. */
export interface CredentialAgentAccess {
  id: string;
  credentialId: string;
  agentUserId: string;
  agentName: string | null;
  agentEmail: string | null;
  agentIsBot: boolean;
  apiKeyId: string | null;
  apiKeyName: string | null;
  apiKeyPrefix: string | null;
  oauthClientId: string | null;
  oauthClientName: string | null;
  purposes: Array<'reveal' | 'totp' | 'file_download' | 'browser_login' | 'ssh'>;
  source: 'manual' | 'audit_seed';
  grantedBy: string | null;
  grantedAt: string;
}
