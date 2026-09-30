/** ORB-2272, ORB-2274 - an orboto_api_call on a tail route is logged under the tool name it stands in for; leaf module. */

interface TailLabel {
  method: string;
  path: RegExp;
  label: string;
}

const SEG = '[^/]+';

export const TAIL_LABELS: readonly TailLabel[] = [
  { method: 'GET', path: new RegExp(`^/capacity/resources(/${SEG}(/queue)?)?$`), label: 'orboto_capacity_list' },
  { method: 'GET', path: new RegExp(`^/capacity/claims(/${SEG})?$`), label: 'orboto_capacity_list' },
  { method: 'POST', path: /^\/capacity\/claims$/, label: 'orboto_capacity_claim' },
  { method: 'POST', path: new RegExp(`^/capacity/claims/${SEG}/renew$`), label: 'orboto_capacity_renew' },
  { method: 'POST', path: new RegExp(`^/capacity/claims/${SEG}/release$`), label: 'orboto_capacity_release' },
  { method: 'GET', path: /^\/capacity\/windows$/, label: 'orboto_capacity_windows' },
  { method: 'GET', path: new RegExp(`^/capacity/resources/${SEG}/plan$`), label: 'orboto_capacity_plan' },
  { method: 'POST', path: new RegExp(`^/capacity/resources/${SEG}/plan$`), label: 'orboto_capacity_plan' },
  { method: 'POST', path: /^\/capacity\/seeds\/nightly-unity$/, label: 'orboto_capacity_seed' },
];

/** The metrics label of one tool call: the stand-in tool name for a labelled api_call, else the tool name itself. */
export function metricsToolName(toolName: string, args: unknown): string {
  if (toolName !== 'orboto_api_call' || !args || typeof args !== 'object') return toolName;
  const { method, path } = args as { method?: unknown; path?: unknown };
  if (typeof method !== 'string' || typeof path !== 'string') return toolName;
  const bare = path.split('?')[0]!.replace(/\/+$/, '');
  const hit = TAIL_LABELS.find((l) => l.method === method.toUpperCase() && l.path.test(bare));
  return hit ? hit.label : toolName;
}

/** The inner HTTP status of an api_call envelope, so a labelled call that the API refused counts as a failure. */
export function envelopeStatus(structured: unknown): number | undefined {
  const status = (structured as { status?: unknown } | undefined)?.status;
  return typeof status === 'number' ? status : undefined;
}
