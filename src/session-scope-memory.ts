/**
 * ORB-2209 - the scope this process declared, per instance token, for the
 * process lifetime. The inbox channel re-sends it on every stream reconnect,
 * so a session whose row is gone never has to declare it twice; a proxy that
 * never declared one, or cleared it, re-sends nothing.
 */
import type { AgentSessionScope } from './tools/agent-session-scope.js';

const declared = new Map<string, AgentSessionScope | null>();

/** A declaration made through this process: a scope, or null for a deliberate clear. */
export function rememberDeclaredScope(instanceToken: string, scope: AgentSessionScope | null): void {
  declared.set(instanceToken, scope && Object.keys(scope).length > 0 ? scope : null);
}

/** The scope the server confirmed on connect replaces the remembered one, once this process declared any. */
export function confirmScope(instanceToken: string, scope: AgentSessionScope | null): void {
  if (declared.has(instanceToken) && scope) declared.set(instanceToken, scope);
}

/** What a reconnect re-sends: the last declared scope, or null. */
export function rememberedScope(instanceToken: string): AgentSessionScope | null {
  return declared.get(instanceToken) ?? null;
}

/** Test seam. */
export function _forgetDeclaredScopes(): void {
  declared.clear();
}
