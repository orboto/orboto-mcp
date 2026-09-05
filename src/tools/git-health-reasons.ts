// Shared rendering vocabulary for session-start and work-session bundles.
export const GIT_HEALTH_REASON_TEXT: Record<string, string> = {
  connection_inactive: 'connection is deactivated',
  app_installation_suspended: 'GitHub App installation is suspended',
  oauth_token_expired: 'OAuth token expired with no refresh path',
  history_backfill_error: 'last history backfill failed',
  awaiting_first_event: 'webhook installed but has never delivered an event',
  outbound_unreachable: 'orboto cannot reach the provider',
  delivery_failing: 'webhook deliveries from the provider are not arriving',
};
