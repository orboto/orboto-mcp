/**
 * ORB-244 Phase D — prompt template unit tests.
 *
 * Prompts are stateless: handler returns a `messages[]` shape based
 * purely on input args. We register against a real McpServer and
 * read back via the SDK's internal registry, then assert the
 * returned message text mentions (a) the goal, (b) the tools the
 * model is supposed to call.
 */
import { describe, expect, it } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerOrbitPrompts } from './prompts.js';

interface PromptEntry {
  callback: (args: Record<string, string>) => { messages: Array<{ role: string; content: { type: string; text: string } }> };
}

function buildServerWithPrompts() {
  const server = new McpServer({ name: 'test', version: '0.0.0' });
  registerOrbitPrompts(server);
  return server;
}

function getPromptHandler(server: McpServer, name: string): PromptEntry['callback'] {
  const prompts = (server as unknown as { _registeredPrompts: Record<string, PromptEntry> })._registeredPrompts;
  const entry = prompts[name];
  if (!entry) throw new Error(`No prompt "${name}" — known: ${Object.keys(prompts).join(', ')}`);
  return entry.callback;
}

describe('plan-sprint prompt', () => {
  it('emits a single user message that names the project + tool sequence', () => {
    const server = buildServerWithPrompts();
    const handler = getPromptHandler(server, 'plan-sprint');
    const out = handler({ projectKey: 'ACME' });
    expect(out.messages).toHaveLength(1);
    expect(out.messages[0].role).toBe('user');
    const text = out.messages[0].content.text;
    expect(text).toContain('project ACME');
    expect(text).toContain('orbit_get_project');
    expect(text).toContain('orbit_list_tickets');
    expect(text).toContain('orbit_list_milestones');
  });
});

describe('triage-my-tickets prompt', () => {
  it('takes no args and instructs to call orbit_my_tickets', () => {
    const server = buildServerWithPrompts();
    const handler = getPromptHandler(server, 'triage-my-tickets');
    const out = handler({});
    const text = out.messages[0].content.text;
    expect(text).toContain('orbit_my_tickets');
    expect(text).toContain('top 3');
  });
});

describe('summarize-project prompt', () => {
  it('embeds the project key + asks for exactly 3 sentences', () => {
    const server = buildServerWithPrompts();
    const handler = getPromptHandler(server, 'summarize-project');
    const out = handler({ projectKey: 'ACME' });
    const text = out.messages[0].content.text;
    expect(text).toContain('project ACME');
    expect(text).toContain('exactly 3 sentences');
  });
});

describe('estimate-ticket prompt', () => {
  it('embeds the ticket key + asks for similar past tickets', () => {
    const server = buildServerWithPrompts();
    const handler = getPromptHandler(server, 'estimate-ticket');
    const out = handler({ ticketKey: 'ACME-42' });
    const text = out.messages[0].content.text;
    expect(text).toContain('ACME-42');
    expect(text).toContain('orbit_search');
    expect(text).toContain('loggedMinutes');
  });
});

describe('find-duplicates prompt', () => {
  it('warns explicitly against false positives', () => {
    const server = buildServerWithPrompts();
    const handler = getPromptHandler(server, 'find-duplicates');
    const out = handler({ ticketKey: 'ACME-7' });
    const text = out.messages[0].content.text;
    expect(text).toContain('ACME-7');
    expect(text).toContain('False positives');
  });
});
