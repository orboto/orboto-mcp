/**
 * ORB-1692 / ORB-1817 - strict inputs + measured aliases + the teaching
 * error.
 *
 * Table-driven against the REAL tool configs: each alias from the
 * measurement table must resolve to the canonical field, unknown keys
 * must error naming the offender, and the ORB-1684 silent-drop case
 * (create_ticket with parentKey) must never come back.
 *
 * ORB-1817 - a call that still can't be resolved after aliasing now
 * THROWS (from every parse entry point, `.safeParse()` included - see
 * the module doc on `buildStrictInputSchema` for why: the teaching error
 * is thrown from inside a zod "preprocess" effect, which runs before the
 * sync/async branch even exists). That's an intentional behaviour change
 * from plain zod (whose `.safeParse()` never throws) - every test below
 * that used to check `parsed.success === false` now checks the throw.
 */
import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import { buildStrictInputSchema, isRawShape, GLOBAL_INPUT_ALIASES } from './input-schema.js';
import type { OrbotoClient } from './orboto-client.js';
import {
  commentToolConfig,
  updateTicketToolConfig,
  addTicketDependencyToolConfig,
  moveTicketToolConfig,
  createTicketToolConfig,
  updateCommentToolConfig,
} from './tools/ticket-writes.js';
import { setParentToolConfig } from './tools/set-parent.js';
import { getMilestoneToolConfig } from './tools/milestones.js';
import { getTicketToolConfig } from './tools/get-ticket.js';
import { listTicketsToolConfig } from './tools/list-tickets.js';
import { getDocToolConfig } from './tools/docs.js';
import { queryToolConfig } from './tools/query.js';
import { bulkMoveTicketsToolConfig } from './tools/bulk-writes.js';

function schemaFor(toolName: string, config: { inputSchema: z.ZodRawShape }) {
  return buildStrictInputSchema(toolName, config.inputSchema);
}

/** Parse and return the thrown message's parsed JSON body (ORB-1817: an
 *  invalid call throws instead of returning `{success:false}`). */
function throwsWith(schema: z.ZodTypeAny, value: unknown): Record<string, unknown> {
  let caught: unknown;
  try {
    schema.safeParse(value);
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(Error);
  return JSON.parse((caught as Error).message) as Record<string, unknown>;
}

describe('measured aliases resolve to the canonical field', () => {
  const CASES: Array<{
    tool: string; config: { inputSchema: z.ZodRawShape };
    send: Record<string, unknown>; expectKey: string; expectValue: unknown;
  }> = [
    { tool: 'orboto_comment', config: commentToolConfig, send: { ticketKey: 'ORB-1', body: 'hi' }, expectKey: 'text', expectValue: 'hi' },
    { tool: 'orboto_add_ticket_dependency', config: addTicketDependencyToolConfig, send: { ticketKey: 'ORB-1', dependsOnTicketKey: 'ORB-2' }, expectKey: 'dependsOnKey', expectValue: 'ORB-2' },
    { tool: 'orboto_get_doc', config: getDocToolConfig, send: { docKey: 'ORB-D12' }, expectKey: 'docId', expectValue: 'ORB-D12' },
    { tool: 'orboto_move_ticket', config: moveTicketToolConfig, send: { ticketKey: 'ORB-1', status: 'done' }, expectKey: 'statusCategory', expectValue: 'done' },
    { tool: 'orboto_set_parent', config: setParentToolConfig, send: { ticketKey: 'ORB-1', parentKey: 'ORB-9' }, expectKey: 'parentTicketKey', expectValue: 'ORB-9' },
    { tool: 'orboto_get_milestone', config: getMilestoneToolConfig, send: { projectKey: 'ORB', milestoneKey: 'ORB-M3' }, expectKey: 'milestone', expectValue: 'ORB-M3' },
    { tool: 'orboto_get_ticket', config: getTicketToolConfig, send: { ticket: 'ORB-1' }, expectKey: 'ticketKey', expectValue: 'ORB-1' },
    { tool: 'orboto_list_tickets', config: listTicketsToolConfig, send: { project: 'ORB' }, expectKey: 'projectKey', expectValue: 'ORB' },
  ];

  for (const c of CASES) {
    it(`${c.tool}: ${Object.keys(c.send).join('+')} -> ${c.expectKey}`, () => {
      const parsed = schemaFor(c.tool, c.config).safeParse(c.send);
      expect(parsed.success, JSON.stringify('error' in parsed ? parsed.error : '')).toBe(true);
      if (parsed.success) {
        const data = parsed.data as Record<string, unknown>;
        expect(data[c.expectKey]).toBe(c.expectValue);
        expect(Object.keys(c.send).find((k) => GLOBAL_INPUT_ALIASES[k]) as string in data).toBe(false);
      }
    });
  }
});

describe('the ORB-1684 regression: silent drops are dead', () => {
  it('create_ticket with parentKey sets parentTicketKey - never vanishes', () => {
    const parsed = schemaFor('orboto_create_ticket', createTicketToolConfig)
      .safeParse({ projectKey: 'ORB', title: 'x', parentKey: 'ORB-1691' });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect((parsed.data as Record<string, unknown>).parentTicketKey).toBe('ORB-1691');
    }
  });

  it('an unknown key errors and names the offender', () => {
    const body = throwsWith(
      schemaFor('orboto_create_ticket', createTicketToolConfig),
      { projectKey: 'ORB', title: 'x', bogusField: 1 },
    );
    expect(body.unrecognized).toEqual(['bogusField']);
  });
});

describe('update_ticket: flat fields fold into patch', () => {
  it('{ticketKey, description} becomes {ticketKey, patch:{description}}', () => {
    const parsed = schemaFor('orboto_update_ticket', updateTicketToolConfig)
      .safeParse({ ticketKey: 'ORB-1', description: 'new text', priority: 'high' });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      const data = parsed.data as { patch: Record<string, unknown> };
      expect(data.patch).toEqual({ description: 'new text', priority: 'high' });
    }
  });

  it('an explicit patch wins - flat extras next to a patch stay an error', () => {
    const body = throwsWith(
      schemaFor('orboto_update_ticket', updateTicketToolConfig),
      { ticketKey: 'ORB-1', patch: { title: 'a' }, description: 'b' },
    );
    expect(body.unrecognized).toEqual(['description']);
  });
});

describe('alias guard: canonical-field collisions are never renamed', () => {
  it('a tool whose REAL field is `body` keeps it', () => {
    const shape = { id: z.string(), body: z.string() };
    const parsed = buildStrictInputSchema('orboto_update_agent_instruction', shape)
      .safeParse({ id: 'x', body: 'the rule text' });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect((parsed.data as Record<string, unknown>).body).toBe('the rule text');
    }
  });

  it('alias is ignored when the caller also sent the canonical field', () => {
    // both present: no rename happens, so `body` is an unknown key -> error
    const body = throwsWith(
      schemaFor('orboto_comment', commentToolConfig),
      { ticketKey: 'ORB-1', text: 'real', body: 'stray' },
    );
    expect(body.unrecognized).toEqual(['body']);
  });
});

describe('ORB-1817: extended alias table', () => {
  const CASES: Array<{
    tool: string; config: { inputSchema: z.ZodRawShape };
    send: Record<string, unknown>; expectKey: string; expectValue: unknown;
  }> = [
    { tool: 'orboto_get_ticket', config: getTicketToolConfig, send: { key: 'ORB-1' }, expectKey: 'ticketKey', expectValue: 'ORB-1' },
    { tool: 'orboto_query', config: queryToolConfig, send: { query: 'project = ORB' }, expectKey: 'oql', expectValue: 'project = ORB' },
    { tool: 'orboto_get_milestone', config: getMilestoneToolConfig, send: { projectKey: 'ORB', milestoneId: 'ORB-M3' }, expectKey: 'milestone', expectValue: 'ORB-M3' },
    { tool: 'orboto_list_tickets', config: listTicketsToolConfig, send: { projectId: 'ORB' }, expectKey: 'projectKey', expectValue: 'ORB' },
    { tool: 'orboto_comment', config: commentToolConfig, send: { ticketKey: 'ORB-1', comment: 'hi' }, expectKey: 'text', expectValue: 'hi' },
    { tool: 'orboto_comment', config: commentToolConfig, send: { ticketKey: 'ORB-1', message: 'hi' }, expectKey: 'text', expectValue: 'hi' },
    { tool: 'orboto_bulk_move_tickets', config: bulkMoveTicketsToolConfig, send: { keys: ['ORB-1', 'ORB-2'], statusCategory: 'done' }, expectKey: 'ticketKeys', expectValue: ['ORB-1', 'ORB-2'] },
    { tool: 'orboto_query', config: queryToolConfig, send: { oql: 'project = ORB', max: 10 }, expectKey: 'limit', expectValue: 10 },
    { tool: 'orboto_query', config: queryToolConfig, send: { oql: 'project = ORB', page: 'c1' }, expectKey: 'cursor', expectValue: 'c1' },
    // `id` -> the tool's single id-shaped parameter (ticketKey here).
    { tool: 'orboto_get_ticket', config: getTicketToolConfig, send: { id: 'ORB-1' }, expectKey: 'ticketKey', expectValue: 'ORB-1' },
    { tool: 'orboto_get_doc', config: getDocToolConfig, send: { id: 'ORB-D12' }, expectKey: 'docId', expectValue: 'ORB-D12' },
  ];

  for (const c of CASES) {
    it(`${c.tool}: ${Object.keys(c.send).join('+')} -> ${c.expectKey}`, () => {
      const parsed = schemaFor(c.tool, c.config).safeParse(c.send);
      expect(parsed.success, JSON.stringify('error' in parsed ? parsed.error : '')).toBe(true);
      if (parsed.success) {
        const data = parsed.data as Record<string, unknown>;
        expect(data[c.expectKey]).toEqual(c.expectValue);
      }
    });
  }

  it('`id` is left alone (and errors) when the tool has more than one id-shaped parameter', () => {
    // orboto_update_comment has BOTH ticketKey and commentId - ambiguous.
    const body = throwsWith(
      schemaFor('orboto_update_comment', updateCommentToolConfig),
      { id: 'ORB-1', text: 'hi' },
    );
    expect(body.unrecognized).toEqual(['id']);
  });
});

describe('ORB-1817: teaching error', () => {
  it('names every parameter the tool accepts', () => {
    const body = throwsWith(
      schemaFor('orboto_get_ticket', getTicketToolConfig),
      { bogus: 1 },
    );
    expect(body.code).toBe(-32602);
    const expected = body.expected as { tool: string; parameters: Array<{ name: string; required: boolean }> };
    expect(expected.tool).toBe('orboto_get_ticket');
    expect(expected.parameters.map((p) => p.name)).toContain('ticketKey');
    const ticketKeyParam = expected.parameters.find((p) => p.name === 'ticketKey');
    expect(ticketKeyParam?.required).toBe(true);
  });

  it('suggests the closest valid name for a typo (Levenshtein <= 2)', () => {
    const body = throwsWith(
      schemaFor('orboto_get_ticket', getTicketToolConfig),
      { ticketKye: 'ORB-1' },
    );
    expect(body.didYouMean).toEqual({ ticketKye: 'ticketKey' });
  });

  it('names missing required parameters when nothing is unrecognized', () => {
    const body = throwsWith(
      schemaFor('orboto_add_ticket_dependency', addTicketDependencyToolConfig),
      { ticketKey: 'ORB-1' },
    );
    expect(body.missing).toEqual(['dependsOnKey']);
    expect(body.unrecognized).toBeUndefined();
  });
});

describe('ORB-1817: validation failures are instrumented (Part C)', () => {
  it('a bad input logs through the same /admin/mcp/instrument path a handler error uses', () => {
    const post = vi.fn().mockResolvedValue(undefined);
    const fakeClient = { post } as unknown as OrbotoClient;
    const schema = buildStrictInputSchema(
      'orboto_get_ticket', getTicketToolConfig.inputSchema, fakeClient, 'test-client',
    );

    expect(() => schema.safeParse({ bogus: 1 })).toThrow();

    expect(post).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledWith('/admin/mcp/instrument', expect.objectContaining({
      toolName: 'orboto_get_ticket',
      success: false,
      statusCode: -32602,
      clientHint: 'test-client',
    }));
  });

  it('a valid input never logs', () => {
    const post = vi.fn().mockResolvedValue(undefined);
    const fakeClient = { post } as unknown as OrbotoClient;
    const schema = buildStrictInputSchema(
      'orboto_get_ticket', getTicketToolConfig.inputSchema, fakeClient, 'test-client',
    );

    schema.safeParse({ ticketKey: 'ORB-1' });

    expect(post).not.toHaveBeenCalled();
  });
});

describe('SDK advertisement contract', () => {
  it('the wrapped schema keeps .shape (tools/list must not go empty)', () => {
    const s = schemaFor('orboto_comment', commentToolConfig) as unknown as { shape?: z.ZodRawShape };
    expect(s.shape).toBeDefined();
    expect(Object.keys(s.shape ?? {})).toContain('text');
  });

  it('isRawShape tells shapes from schema instances', () => {
    expect(isRawShape(commentToolConfig.inputSchema)).toBe(true);
    expect(isRawShape(z.object({ a: z.string() }))).toBe(false);
    expect(isRawShape({})).toBe(false);
    expect(isRawShape(undefined)).toBe(false);
  });
});
