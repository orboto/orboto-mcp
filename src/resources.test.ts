/**
 * ORB-244 Phase D — resources unit tests.
 *
 * The MCP SDK's resource-template handlers are normal functions
 * once registered. Pulling them off the server's internal registry
 * would couple us to SDK internals; instead we register against a
 * real McpServer and read back via the protocol-shaped
 * `_registeredResourceTemplates` accessor. If the SDK renames it,
 * the test fails loudly, but that's the point — we want to know.
 *
 * Each test exercises the URI → handler-output path with the
 * stubbed orboto REST client.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { OrbotoClient } from './orboto-client.js';
import { registerOrbotoResources } from './resources.js';

beforeEach(() => { vi.restoreAllMocks(); });
afterEach(() => { vi.restoreAllMocks(); });

function stub(responses: Array<{ ok?: boolean; status?: number; json?: unknown }>) {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
    const r = responses.shift();
    if (!r) throw new Error('unexpected fetch');
    return {
      ok: r.ok ?? true,
      status: r.status ?? 200,
      statusText: 'OK',
      json: async () => ('json' in r ? r.json : {}),
      text: async () => '',
    } as unknown as Response;
  });
}

const client = new OrbotoClient({ baseUrl: 'https://orboto.example.com', apiKey: 'orb_x' });

function buildServerWithResources() {
  const server = new McpServer({ name: 'test', version: '0.0.0' });
  registerOrbotoResources(server, client);
  return server;
}

/** Pull a registered resource-template handler off the McpServer. */
function getTemplateHandler(server: McpServer, name: string) {
  const templates = (server as unknown as { _registeredResourceTemplates: Record<string, { readCallback: (uri: URL, vars: Record<string, string>) => Promise<{ contents: Array<{ text: string }> }> }> })._registeredResourceTemplates;
  const entry = templates[name];
  if (!entry) throw new Error(`No registered resource template "${name}" — known: ${Object.keys(templates).join(', ')}`);
  return entry.readCallback;
}

describe('orboto:// ticket resource', () => {
  it('renders a ticket as Markdown with description + comments', async () => {
    stub([
      // resolveTicketByKey: project lookup
      { json: { id: 'p1', key: 'ACME', name: 'Acme', description: null, status: 'active' } },
      // resolveTicketByKey: ticket
      {
        json: {
          id: 't1', projectId: 'p1', ticketKey: 'ACME-7', title: 'Login bug',
          description: 'Login fails on Safari.', type: 'bug', priority: 'high',
          status: 'IN_PROGRESS', statusName: 'In Progress', dueDate: null,
          isPrivate: false, estimatedTimeMinutes: 0,
          assignees: [{ id: 'u1', email: 'ada@acme', fullName: 'Ada' }],
          labels: [{ id: 'l1', name: 'bug' }],
        },
      },
      // comments page
      {
        json: {
          items: [
            { content: 'looking into this', userName: 'Ada', createdAt: 'now', isInternal: false },
          ],
          nextCursor: null,
        },
      },
    ]);

    const server = buildServerWithResources();
    const handler = getTemplateHandler(server, 'ticket');
    const out = await handler(new URL('orboto://ticket/ACME-7'), { ticketKey: 'ACME-7' });

    const text = out.contents[0]?.text;
    expect(text).toContain('# [ACME-7] Login bug');
    expect(text).toContain('Status: In Progress');
    expect(text).toContain('Priority: high');
    expect(text).toContain('Assignees: Ada');
    expect(text).toContain('## Description');
    expect(text).toContain('Login fails on Safari.');
    expect(text).toContain('## Comments (1)');
    expect(text).toContain('looking into this');
  });

  it('handles a ticket with no comments (404 from comments endpoint) gracefully', async () => {
    stub([
      { json: { id: 'p1', key: 'ACME', name: 'Acme', description: null, status: 'active' } },
      {
        json: {
          id: 't1', projectId: 'p1', ticketKey: 'ACME-8', title: 'Plain', type: 'task',
          priority: 'normal', status: 'TODO', statusName: 'To Do', dueDate: null,
          isPrivate: false, estimatedTimeMinutes: 0, description: null,
        },
      },
      { ok: false, status: 404, json: { error: 'not found' } },
    ]);

    const server = buildServerWithResources();
    const handler = getTemplateHandler(server, 'ticket');
    const out = await handler(new URL('orboto://ticket/ACME-8'), { ticketKey: 'ACME-8' });
    const text = out.contents[0]?.text;
    expect(text).toContain('# [ACME-8] Plain');
    expect(text).not.toContain('## Comments');
  });
});

describe('orboto:// doc resource', () => {
  it('renders the doc title + body as Markdown', async () => {
    stub([{
      json: {
        id: 'd1', title: 'Runbook', content: '## Restart\n\n1. ssh in\n2. systemctl restart',
        visibility: 'workspace', updatedAt: '2026-04-25T07:00:00Z',
      },
    }]);
    const server = buildServerWithResources();
    const handler = getTemplateHandler(server, 'doc');
    const out = await handler(new URL('orboto://doc/d1'), { docId: 'd1' });
    const text = out.contents[0]?.text;
    expect(text).toContain('# Runbook');
    expect(text).toContain('Visibility: workspace');
    expect(text).toContain('## Restart');
  });
});

describe('orboto:// project resource', () => {
  it('aggregates project + milestones + members into Markdown', async () => {
    stub([
      // resolveProjectByKey
      { json: { id: 'p1', key: 'ACME', name: 'Acme Inc', description: 'CRM build', status: 'active' } },
      // milestones
      { json: [{ id: 'm1', name: 'v1', status: 'active', startDate: '2026-04-01', endDate: '2026-05-01' }] },
      // members
      { json: [{ user: { email: 'ada@acme', fullName: 'Ada' }, role: { name: 'developer' } }] },
    ]);
    const server = buildServerWithResources();
    const handler = getTemplateHandler(server, 'project');
    const out = await handler(new URL('orboto://project/ACME'), { projectKey: 'ACME' });
    const text = out.contents[0]?.text;
    expect(text).toContain('# ACME — Acme Inc');
    expect(text).toContain('## Milestones');
    expect(text).toContain('**v1** [active]');
    expect(text).toContain('## Members');
    expect(text).toContain('Ada <ada@acme> — developer');
  });
});

describe('orboto:// search resource', () => {
  it('renders top hits when results are present', async () => {
    stub([{
      json: {
        items: [
          { type: 'ticket', ticketKey: 'ACME-1', title: 'Login bug', excerpt: '…fails on Safari…', url: '/x', projectName: 'Acme' },
        ],
        total: 1,
      },
    }]);
    const server = buildServerWithResources();
    const handler = getTemplateHandler(server, 'search');
    const out = await handler(new URL('orboto://search/login'), { query: 'login' });
    const text = out.contents[0]?.text;
    expect(text).toContain('# Search: login');
    expect(text).toContain('TICKET ACME-1');
    expect(text).toContain('Login bug');
  });

  it('renders an explicit empty-state when no hits', async () => {
    stub([{ json: { items: [], total: 0 } }]);
    const server = buildServerWithResources();
    const handler = getTemplateHandler(server, 'search');
    const out = await handler(new URL('orboto://search/zzz'), { query: 'zzz' });
    const text = out.contents[0]?.text;
    expect(text).toContain('# Search: zzz');
    expect(text).toContain('_No hits._');
  });
});

describe('orboto:// rules resource (ORB-1177)', () => {
  it('returns the complete assembled workspace rules', async () => {
    stub([{ json: { instructions: 'RULE 1: ticket-first.\nRULE 2: one commit per ticket.' } }]);
    const server = buildServerWithResources();
    const handler = getTemplateHandler(server, 'rules');
    const out = await handler(new URL('orboto://rules'), {});
    const text = out.contents[0]?.text;
    expect(text).toContain('# orboto workspace agent rules');
    expect(text).toContain('RULE 1: ticket-first.');
    expect(text).toContain('RULE 2: one commit per ticket.');
  });

  it('degrades to a placeholder when no rules are configured', async () => {
    stub([{ json: { instructions: '' } }]);
    const server = buildServerWithResources();
    const handler = getTemplateHandler(server, 'rules');
    const out = await handler(new URL('orboto://rules'), {});
    expect(out.contents[0]?.text).toContain('(no workspace rules configured)');
  });
});
