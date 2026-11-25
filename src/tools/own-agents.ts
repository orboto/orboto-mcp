/**
 * ORB-3258 - `orboto_own_agents`: list your own agent accounts, create one, or retire one for good. One named tool with
 * three actions, because the full manifest has no room for three. Reactivate and rename need a request the person sends
 * themselves, which an MCP call never is (Profile -> My agent accounts, `orboto agents reactivate|rename`).
 */
import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { OrbotoClient } from '../orboto-client.js';
import type { OwnAgent, OwnAgentDeactivated } from './own-agents-result.js';

/** The CLI profile name for an agent account of this name; the same rule as ownAgentProfileName in @orboto/shared-schema. */
export function profileNameFor(fullName: string): string {
  const slug = fullName.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/-{2,}/g, '-').replace(/^[-_0-9]+|[-_]+$/g, '');
  return (slug || 'agent').slice(0, 48).replace(/[-_]+$/, '');
}

export function signInSteps(agent: Pick<OwnAgent, 'fullName'>): string {
  const profile = profileNameFor(agent.fullName);
  return `Sign it in: \`orboto login --profile ${profile}\`, choose "${agent.fullName}" under "Act as", then \`orboto profile bind claude ${profile}\`.`;
}

function line(agent: OwnAgent): string {
  const state = agent.isActive === false ? 'deactivated' : 'active';
  const managed = agent.manageable === false ? ', assigned by an administrator' : '';
  return `${agent.id} ${agent.fullName} <${agent.email}>: ${state}${managed}${agent.createdAt ? `, created ${agent.createdAt}` : ''}`;
}

export const ownAgentsToolConfig = {
  title: 'Own agents',
  description: 'Your agent accounts: list, create (name), or deactivate (id): its API keys are deleted and its OAuth tokens revoked for good. list shows id, name, e-mail, active or deactivated, created, and manageable false for one an administrator assigned and manages. create needs agent:create-own; the workspace limit counts your active own accounts (409 names it); the account gets the service-account role and your project memberships, never more than you hold, and the answer names the sign-in commands. deactivate also ends its grants, leases, capacity claims and work sessions and closes its connections; reactivating needs you yourself in Profile -> My agent accounts or `orboto agents reactivate`, and a fresh sign-in.',
  inputSchema: z.object({ action: z.enum(['list', 'create', 'deactivate']).optional(), name: z.string().optional(), id: z.string().optional() }).shape,
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
};

type Args = { action?: 'list' | 'create' | 'deactivate'; name?: string; id?: string };

export function makeOwnAgentsHandler(client: OrbotoClient) {
  return async (args: Args = {}): Promise<CallToolResult> => {
    const action = args.action ?? 'list';
    if (action === 'create') {
      if (!args.name?.trim()) throw new Error('create needs name: the name of the new agent account.');
      const agent = await client.post<OwnAgent>('/users/me/agents', { fullName: args.name });
      return { content: [{ type: 'text', text: `Created ${line(agent)}.\n${signInSteps(agent)}` }], structuredContent: { action, agent } };
    }
    if (action === 'deactivate') {
      if (!args.id) throw new Error('deactivate needs id: the agent account (action list shows the ids).');
      const agent = await client.post<OwnAgentDeactivated>(`/users/me/agents/${encodeURIComponent(args.id)}/deactivate`, {});
      const r = agent.revoked;
      const text = `Deactivated ${agent.fullName} <${agent.email}>: ${r.apiKeys} API keys deleted, ${r.oauthTokens} OAuth tokens and ${r.authorizationCodes} codes revoked, ${r.workSessions} work sessions, ${r.browserGrants} browser grants, ${r.liveLeases} live leases and ${r.capacityClaims} capacity claims ended. Reactivate it in Profile -> My agent accounts or with \`orboto agents reactivate ${agent.id}\`, then sign it in again.`;
      return { content: [{ type: 'text', text }], structuredContent: { action, agent } };
    }
    const agents = await client.get<OwnAgent[]>('/users/me/owned-bots?include=inactive');
    const text = agents.length ? agents.map(line).join('\n') : 'You own no agent accounts. Action create makes one.';
    return { content: [{ type: 'text', text }], structuredContent: { action, agents } };
  };
}
