/**
 * ORB-1692 - strict inputs + measured aliases.
 *
 * Table-driven against the REAL tool configs: each alias from the
 * measurement table must resolve to the canonical field, unknown keys
 * must error naming the offender, and the ORB-1684 silent-drop case
 * (create_ticket with parentKey) must never come back.
 */
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { buildStrictInputSchema, isRawShape, GLOBAL_INPUT_ALIASES } from './input-schema.js';
import {
  commentToolConfig,
  updateTicketToolConfig,
  addTicketDependencyToolConfig,
  moveTicketToolConfig,
  createTicketToolConfig,
} from './tools/ticket-writes.js';
import { setParentToolConfig } from './tools/set-parent.js';
import { getMilestoneToolConfig } from './tools/milestones.js';
import { getTicketToolConfig } from './tools/get-ticket.js';
import { listTicketsToolConfig } from './tools/list-tickets.js';
import { getDocToolConfig } from './tools/docs.js';

function schemaFor(toolName: string, config: { inputSchema: z.ZodRawShape }) {
  return buildStrictInputSchema(toolName, config.inputSchema);
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
    const parsed = schemaFor('orboto_create_ticket', createTicketToolConfig)
      .safeParse({ projectKey: 'ORB', title: 'x', bogusField: 1 });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(JSON.stringify(parsed.error.issues)).toContain('bogusField');
    }
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
    const parsed = schemaFor('orboto_update_ticket', updateTicketToolConfig)
      .safeParse({ ticketKey: 'ORB-1', patch: { title: 'a' }, description: 'b' });
    expect(parsed.success).toBe(false);
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
    const parsed = schemaFor('orboto_comment', commentToolConfig)
      .safeParse({ ticketKey: 'ORB-1', text: 'real', body: 'stray' });
    // both present: no rename happens, so `body` is an unknown key -> error
    expect(parsed.success).toBe(false);
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
