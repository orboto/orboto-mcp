export const GIT_HEALTH_REASON_TEXT: Record<string, string> = {
  connection_inactive: 'connection is deactivated',
  app_installation_suspended: 'GitHub App installation is suspended',
  oauth_token_expired: 'OAuth token expired with no refresh path',
  history_backfill_error: 'last history backfill failed',
  awaiting_first_event: 'webhook installed but has never delivered an event',
  outbound_unreachable: 'orboto cannot reach the provider',
  delivery_failing: 'webhook deliveries from the provider are not arriving',
  token_rejected: 'the provider rejects the stored credential',
};

/** ORB-2834 - a connection no probe has checked yet, with the start of the next fleet probe cycle and the command that checks it now. */
export function probePendingLine(projectKey: string, c: { connectionId: string; name: string; provider: string; nextProbeAt?: string | null }): string {
  return `- "${c.name}" (${c.provider}) of ${projectKey} is not probed yet; the next fleet probe cycle starts at ${c.nextProbeAt ?? 'its next tick'}, or probe it now: orboto git probe --project ${projectKey} --connection ${c.connectionId}`;
}
