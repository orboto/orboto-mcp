/** Mirrors OwnAgent, OwnAgentRevoked and OwnAgentDeactivated of @orboto/shared-schema; the MCP package ships without them, apps/api/src/test/own-agents-mcp-drift.test.ts pins the copy in both directions. */
export interface OwnAgent {
  id: string;
  fullName: string;
  email: string;
  createdAt?: string | undefined;
  isActive?: boolean | undefined;
  manageable?: boolean | undefined;
}

export interface OwnAgentRevoked {
  apiKeys: number;
  oauthTokens: number;
  authorizationCodes: number;
  workSessions: number;
  browserPairings: number;
  browserGrants: number;
  liveLeases: number;
  liveGrants: number;
  credentialGrants: number;
  capacityClaims: number;
  browserRegistrations: number;
  browserRelayRevokes: number;
  browserDriveGrants: number;
  browserDriveLeases: number;
  credentialBrowserGrants: number;
  liveSessions: number;
  calendarFeedTokens: number;
  webSessions: number;
}

export interface OwnAgentDeactivated {
  id: string;
  fullName: string;
  email: string;
  createdAt: string;
  isActive: boolean;
  manageable: boolean;
  revoked: OwnAgentRevoked;
  failedCleanups: string[];
}
