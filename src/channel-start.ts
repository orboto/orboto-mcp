/**
 * ORB-2584 - a stdio server is a wake channel only when its harness delivers
 * one: `orboto claude` marks the start in ORBOTO_CLAUDE_CHANNEL (the Go
 * `orboto mcp serve` checks that the marker names this harness's launcher),
 * or the operator opts in with ORBOTO_MCP_CHANNEL=1. `orboto mcp serve` runs
 * this server at the instance's version, so a launching CLI released before
 * the marker, and a start with no CLI at all, keep the channel they always had
 * (`legacy`). Anything else runs as a plain tool server.
 */

export const CLAUDE_CHANNEL_ENV = 'ORBOTO_CLAUDE_CHANNEL';

/** Mirror of CHANNEL_START_CUTOVER_VERSION in @orboto/shared-schema agent-session-wake.ts. */
export const CHANNEL_START_CUTOVER_VERSION = '0.224.0';

export type ChannelStart = 'orboto-claude' | 'explicit' | 'legacy';

function semver(raw: string): [number, number, number] | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(raw.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** Mirror of releasedBeforeChannelStart: a released version below the cut-over; a dev build, 0.0.0 or no version is current. */
export function releasedBeforeChannelStart(version: string | null | undefined): boolean {
  const parsed = version ? semver(version) : null;
  const cut = semver(CHANNEL_START_CUTOVER_VERSION)!;
  if (!parsed || parsed.every((n) => n === 0)) return false;
  for (let i = 0; i < 3; i += 1) if (parsed[i] !== cut[i]) return parsed[i]! < cut[i]!;
  return false;
}

/** The version of the CLI that launched this server, from the origin it handed over in ORBOTO_ORIGIN; null without one. */
function launchingCliVersion(env: NodeJS.ProcessEnv): string | null {
  const handed = (env.ORBOTO_ORIGIN ?? '').trim();
  if (!handed) return null;
  return new URLSearchParams(handed).get('version')?.trim() ?? '';
}

/**
 * The start that delivers this server's channel, or null. ORBOTO_MCP_CHANNEL=0 wins, then the launcher marker, then
 * ORBOTO_MCP_CHANNEL=1; without them a launching CLI released before the marker (its ORBOTO_ORIGIN version, or only
 * ORBOTO_MCP_CLI_OUTDATED from a CLI too old to hand an origin over) and a start without any CLI are `legacy`.
 */
export function channelStartFromEnv(env: NodeJS.ProcessEnv = process.env): ChannelStart | null {
  const flag = (env.ORBOTO_MCP_CHANNEL ?? '').trim();
  if (flag === '0') return null;
  if (/^[1-9]\d{0,9}$/.test((env[CLAUDE_CHANNEL_ENV] ?? '').trim())) return 'orboto-claude';
  if (flag === '1') return 'explicit';
  const cli = launchingCliVersion(env);
  if (cli !== null) return releasedBeforeChannelStart(cli) ? 'legacy' : null;
  return 'legacy';
}
