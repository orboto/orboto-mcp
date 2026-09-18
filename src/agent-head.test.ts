/**
 * ORB-2161 - the head has one source. Session start prints it before
 * anything else, the onboarding help topic repeats it, and the page and
 * the skill carry the same lines, so a sentence cannot be improved in one
 * place and stay old in the other three.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { AGENT_HEAD_HEADING, AGENT_HEAD_LINES, ONBOARDING_FIRST_FIVE_MINUTES, ONBOARDING_WORK_LOOP, agentHeadText, onboardingText } from './agent-head.js';
import { makeHelpHandler } from './tools/help.js';
import { makeSessionStartHandler } from './tools/session-start.js';
import { OrbotoClient } from './orboto-client.js';

const read = (relative: string) => readFileSync(new URL(`../../../${relative}`, import.meta.url), 'utf8');

const CARRIERS = ['docs/orboto-for-agents.md', 'skills/orboto/SKILL.md'];

const client = new OrbotoClient({ baseUrl: 'https://orboto.example.com', apiKey: 'orb_x' });

beforeEach(() => { vi.restoreAllMocks(); });
afterEach(() => { vi.restoreAllMocks(); });

describe('the agent head (ORB-2161)', () => {
  it('stays four to six lines, so every session can afford it', () => {
    expect(AGENT_HEAD_LINES.length).toBeGreaterThanOrEqual(4);
    expect(AGENT_HEAD_LINES.length).toBeLessThanOrEqual(6);
    for (const line of AGENT_HEAD_LINES) expect(line).not.toContain('\n');
  });

  it.each(CARRIERS)('%s carries every line verbatim', (file) => {
    const page = read(file);
    for (const line of AGENT_HEAD_LINES) expect(page).toContain(line);
  });

  it('is the first thing orboto_session_start prints', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      const path = new URL(url.toString()).pathname;
      const body = path.startsWith('/agent-instructions')
        ? { instructions: 'claim -> commit -> close', rulesHash: 'fixture' }
        : path.startsWith('/users/me/assigned-tickets') ? { items: [] } : {};
      return { ok: true, status: 200, statusText: 'OK', json: async () => body, text: async () => '' } as unknown as Response;
    });
    const res = await makeSessionStartHandler(client)();
    const text = (res.content[0] as { text: string }).text;
    expect(text.startsWith(agentHeadText())).toBe(true);
    expect(text.indexOf(AGENT_HEAD_HEADING)).toBeLessThan(text.indexOf('# orboto session start'));
  });

  it('orboto_help returns the head, the first five minutes and the work loop for the topic "onboarding"', async () => {
    const result = await makeHelpHandler()({ topic: 'onboarding' });
    const text = (result.content?.[0] as { text: string }).text;
    for (const line of AGENT_HEAD_LINES) expect(text).toContain(line);
    for (const step of ONBOARDING_FIRST_FIVE_MINUTES) expect(text).toContain(step);
    for (const step of ONBOARDING_WORK_LOOP) expect(text).toContain(step);
    expect(text).toContain('docs/orboto-for-agents.md');
    expect(result.structuredContent).toMatchObject({ tool: 'topic:onboarding' });
  });

  it('names both topics when an unknown one is asked for', async () => {
    const unknown = (await makeHelpHandler()({ topic: 'nope' })).content?.[0] as { text: string };
    expect(unknown.text).toContain('onboarding');
    expect(unknown.text).toContain('connect');
  });

  it('the onboarding topic repeats the head instead of holding a second copy', () => {
    expect(onboardingText().startsWith(agentHeadText())).toBe(true);
  });
});
