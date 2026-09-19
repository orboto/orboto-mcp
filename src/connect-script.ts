/**
 * ORB-2157 - the one source of the script an agent follows when a person
 * asks it to set orboto up. `orboto_help { topic: "connect" }` returns it,
 * docs/connect-your-agent.md, docs/claude-code.md and skills/orboto/SKILL.md
 * carry the same sentences, and connect-script.test.ts holds them together.
 */

export const CONNECT_SCRIPT_HEADING = 'If you are an AI agent helping a person set this up';

export const CONNECT_SCRIPT_STEPS = [
  'Work one step per message: say in one sentence what the step does and why, run it, show the result, and only then move on.',
  'Run every step you can run yourself - `orboto connect --yes` checks Node and Claude Code, writes the `orboto` server entry for this directory and prints the exact start command with the standing arguments.',
  'Hand the person only the steps that need a human: the browser login, the two `/plugin` commands that install the orboto plugin (a CLI cannot type into a running session), quitting and restarting the session with that command, confirming the servers from `.mcp.json` and, in the development form, the local-development prompt, and, on a Team or Enterprise plan, the one Owner switch that allows channels and lists the plugin.',
  'Give every command the person runs verbatim in its own code block, never paraphrased and never merged into prose.',
  'Verify before you continue: `orboto whoami` for the identity, `orboto mcp status` for the entry of this directory, `orboto connect --verify` for the channel.',
  'Never paste a reference page into the chat - link it and keep the message to the step you are on.',
  'Never ask for an API key, a password or a token in the chat; `orboto login` writes the credential itself.',
  'When a check fails, name the cause from the troubleshooting table, fix it, and repeat the check before the next step.',
  'Finish with `orboto connect --verify` and one real first task, so the person sees their own tickets rather than a success message.',
] as const;

/** The help topic's body: the heading, the numbered steps, the pages to link. */
export function connectScriptText(): string {
  const steps = CONNECT_SCRIPT_STEPS.map((step, index) => `${index + 1}. ${step}`);
  return [
    CONNECT_SCRIPT_HEADING,
    '',
    ...steps,
    '',
    'The pages to link instead of pasting: docs/connect-your-agent.md (the first hour, in plain words),',
    'docs/claude-code.md (start commands, standing arguments, troubleshooting table), docs/mcp-setup.md (any other client).',
  ].join('\n');
}
