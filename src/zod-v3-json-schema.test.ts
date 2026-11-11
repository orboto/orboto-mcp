import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { buildStrictInputSchema, withZodV3JsonSchema } from './input-schema.js';

type Json = { properties: Record<string, Record<string, unknown>>; required?: string[]; additionalProperties?: unknown };

describe('tools/list schemas in the zod 3 shape (ORB-2973)', () => {
  it('advertises a strict tool input as zod-to-json-schema did: no uuid pattern, nested objects closed, no safe-integer range', () => {
    const schema = buildStrictInputSchema('probe_tool', {
      projectId: z.guid(),
      scope: z.object({ role: z.enum(['lead', 'worker']).optional() }).optional(),
      limit: z.number().int().min(1).max(50).optional(),
      count: z.number().int().optional(),
    });
    const json = z.toJSONSchema(schema, { target: 'draft-7', io: 'input' }) as unknown as Json;
    expect(json.properties.projectId).toEqual({ type: 'string', format: 'uuid' });
    expect(json.properties.scope.additionalProperties).toBe(false);
    expect(json.properties.count).toEqual({ type: 'integer' });
    expect(json.properties.limit).toEqual({ type: 'integer', minimum: 1, maximum: 50 });
    expect(json.required).toEqual(['projectId']);
    expect(json.additionalProperties).toBe(false);
  });

  it('renders an output schema with a passthrough block and a record of string keys as zod 3 did', () => {
    const schema = withZodV3JsonSchema(z.object({
      id: z.guid(),
      work: z.record(z.string(), z.number()),
      __truncation: z.object({ handle: z.string() }).passthrough().optional(),
    }), 'output');
    const json = z.toJSONSchema(schema, { target: 'draft-7', io: 'output' }) as unknown as Json;
    expect(json.properties.id).toEqual({ type: 'string', format: 'uuid' });
    expect(json.properties.work).toEqual({ type: 'object', additionalProperties: { type: 'number' } });
    expect(json.properties.__truncation.additionalProperties).toBe(true);
    expect(json.required).toEqual(['id', 'work']);
  });

  it('leaves the schema it wraps parsing as before', () => {
    const schema = withZodV3JsonSchema(z.object({ id: z.guid() }), 'input');
    expect(schema.safeParse({ id: 'not-a-uuid' }).success).toBe(false);
    expect(schema.parse({ id: '00000000-0000-0000-0000-000000000001', extra: 1 })).toEqual({ id: '00000000-0000-0000-0000-000000000001' });
  });
});
