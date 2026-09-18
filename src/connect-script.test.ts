/**
 * ORB-2157 - the setup script has one source. The help topic, the two docs
 * pages and the skill are checked against it, so a sentence cannot be
 * improved in one place and stay old in the other three.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { CONNECT_SCRIPT_HEADING, CONNECT_SCRIPT_STEPS, connectScriptText } from './connect-script.js';
import { makeHelpHandler } from './tools/help.js';

const read = (relative: string) => readFileSync(new URL(`../../../${relative}`, import.meta.url), 'utf8');

const CARRIERS = ['docs/connect-your-agent.md', 'docs/claude-code.md', 'skills/orboto/SKILL.md'];

describe('the connect script', () => {
  it('reads as a numbered script with the pages it links', () => {
    const text = connectScriptText();
    expect(text).toContain(CONNECT_SCRIPT_HEADING);
    CONNECT_SCRIPT_STEPS.forEach((step, index) => expect(text).toContain(`${index + 1}. ${step}`));
    expect(text).toContain('docs/connect-your-agent.md');
  });

  it.each(CARRIERS)('%s carries every step verbatim', (file) => {
    const page = read(file);
    for (const step of CONNECT_SCRIPT_STEPS) expect(page).toContain(step);
  });

  it('orboto_help returns it for the topic "connect"', async () => {
    const result = await makeHelpHandler()({ topic: 'connect' });
    const text = (result.content?.[0] as { text: string }).text;
    for (const step of CONNECT_SCRIPT_STEPS) expect(text).toContain(step);
    expect(result.structuredContent).toMatchObject({ tool: 'topic:connect' });
  });

  it('names the known topics when the topic is unknown, and asks for one when nothing is passed', async () => {
    const handler = makeHelpHandler();
    const unknown = (await handler({ topic: 'nope' })).content?.[0] as { text: string };
    expect(unknown.text).toContain('connect');
    const empty = (await handler({})).content?.[0] as { text: string };
    expect(empty.text).toContain('connect');
  });

  it('still answers a tool name', async () => {
    const result = await makeHelpHandler()({ tool: 'orboto_definitely_not_a_tool' });
    expect((result.content?.[0] as { text: string }).text).toContain('No guidance registered');
  });
});
