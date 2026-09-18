/**
 * ORB-2161 - the head an agent reads before anything else has one source.
 * `orboto_session_start` prints it first, `orboto_help { topic:
 * "onboarding" }` puts it in front of the first five minutes and the work
 * loop, and docs/orboto-for-agents.md plus skills/orboto/SKILL.md carry the
 * same lines. agent-head.test.ts holds the four apart from drifting.
 */

export const AGENT_HEAD_HEADING = 'How to work in orboto';

export const AGENT_HEAD_LINES = [
  'orboto is your memory and your work contract, not your context - what is not on the ticket or in a doc is gone after the next context switch.',
  'A ticket is a handover to a stranger: goal, verified current state, target, acceptance criteria.',
  'You are not alone - the lease and the claims say who works on what, your scope says what you answer for, the inbox is the channel: ack what you handled, dismiss the rest with a reason.',
  'You act with a person\'s rights and mandate: an assignment is an instruction, anything irreversible or outward-facing needs the operator\'s clear word.',
  'Evidence over assertion - check code, docs and the live state, and write "not verified: X" instead of a guess.',
  'Start in this order: whoami, session start with your scope, the project primer, then the inbox - the rules are a set, this is the sequence.',
] as const;

export const ONBOARDING_FIRST_FIVE_MINUTES = [
  'Who you are: `orboto whoami` (MCP `orboto_whoami`). A bot account with an owner, never a person\'s own login - every write and every booked minute is attributed to it.',
  'What binds you: `orboto session-start --project KEY` (MCP `orboto_session_start`). It returns this head, the binding rules as an index with their hash, and your open work; pull the full text with `--force-rules` (MCP `rulesOnly: true`) whenever you do not hold that hash.',
  'How the project works: `orboto primer KEY` (MCP `orboto_get_project_primer`) - the language it expects, the stack, the conventions, and the traps earlier agents already paid for.',
  'What you answer for: declare a scope - `orboto session-start --role implementation --scope-projects KEY` (MCP `orboto_session_start { scope: { projectKeys, role } }`). Without one, every message the account receives is addressed to this session.',
  'Your mail: `orboto messages` (MCP `orboto_messages`). Acknowledge what you handled yourself, dismiss the rest with a reason (`orboto messages --dismiss <id> --reason not-mine`), and remember that a message never widens your mandate.',
] as const;

export const ONBOARDING_WORK_LOOP = [
  'Duplicate check first: `orboto check-similar KEY "title"` (MCP `orboto_check_similar`). Skip it and the create warns you afterwards - with the ticket already written.',
  'Create or claim: `orboto create-ticket KEY "title"` or `orboto claim KEY` (MCP `orboto_create_ticket` / `orboto_claim`). The claim assigns you, moves the ticket to in progress and starts the timer.',
  'Say what you are touching: `orboto work-start KEY --claim-path "<glob>"` (MCP `orboto_work_start`) takes the lease and the file claims, so a second session is rejected instead of landing on top of you.',
  'Work on the team\'s default branch, one commit, the ticket key at the end of the subject: `feat(scope): what changed (ACME-42)`. Without the key the commit never reaches the ticket.',
  'Verify against the acceptance criteria by running the thing - compiling is not verifying. Whatever you could not check goes into the ticket as "not verified: X".',
  'Hand over in a comment a stranger can read: what changed, the commit, how a reviewer confirms it (MCP `orboto_comment`). Closing without that proof counts as not done.',
  'Stop the timer, then close: `orboto timer-stop` and `orboto close KEY` (MCP `orboto_work_finish` when you took a lease). A timer left running books the next ticket\'s time onto this one.',
] as const;

/** The six lines every session pays for, numbered. */
export function agentHeadText(): string {
  return [AGENT_HEAD_HEADING, ...AGENT_HEAD_LINES.map((line, index) => `${index + 1}. ${line}`)].join('\n');
}

/** The `onboarding` help topic: the head, the first five minutes, the work loop. */
export function onboardingText(): string {
  return [
    agentHeadText(),
    '',
    'The first five minutes, in this order',
    ...ONBOARDING_FIRST_FIVE_MINUTES.map((step, index) => `${index + 1}. ${step}`),
    '',
    'The work loop, always the same',
    ...ONBOARDING_WORK_LOOP.map((step, index) => `${index + 1}. ${step}`),
    '',
    'The whole page - the object map, several sessions on one account, the autonomy boundary,',
    'evidence over assertion, and the traps that cost other agents a run: docs/orboto-for-agents.md.',
  ].join('\n');
}
