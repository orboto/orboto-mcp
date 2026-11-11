/**
 * ORB-2973 - the JSON Schema an MCP client reads keeps the shape zod-to-json-schema gave it under zod 3: the override rewrites what zod 4 renders differently
 * while `toJSONSchema` walks a schema, `zodV3JsonSchema()` rewrites the finished document.
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { zodV3JsonSchema, zodV3JsonSchemaOverride } from './zod-v3-compat.js';

type Json = Record<string, unknown>;
const render = (schema: z.core.$ZodType): Json => zodV3JsonSchema(z.toJSONSchema(schema, { target: 'openapi-3.0', override: zodV3JsonSchemaOverride, io: 'input', unrepresentable: 'any' })) as Json;
const property = (schema: z.core.$ZodType, key: string): unknown => (render(schema).properties as Json)[key];

describe('the override while zod renders a schema (ORB-2973)', () => {
  it('an undefined field reads { not: {} }, a void field {}, and neither is required', () => {
    const schema = z.object({ gone: z.undefined(), nothing: z.void(), kept: z.string() });
    expect(property(schema, 'gone')).toEqual({ not: {} });
    expect(property(schema, 'nothing')).toEqual({});
    expect(render(schema).required).toEqual(['kept']);
  });

  it('an integer drops the safe-integer range .int() implies and keeps a bound that was stated', () => {
    expect(property(z.object({ n: z.number().int() }), 'n')).toEqual({ type: 'integer' });
    expect(property(z.object({ n: z.number().int().max(10) }), 'n')).toEqual({ type: 'integer', maximum: 10 });
    expect(property(z.object({ n: z.number().int().max(Number.MAX_SAFE_INTEGER) }), 'n')).toMatchObject({ maximum: Number.MAX_SAFE_INTEGER });
    expect(property(z.object({ n: z.number().int().min(Number.MIN_SAFE_INTEGER) }), 'n')).toMatchObject({ minimum: Number.MIN_SAFE_INTEGER });
    expect(property(z.object({ n: z.number().int().min(-5) }), 'n')).toEqual({ type: 'integer', minimum: -5 });
  });

  it('a default stays on a field whose inner type is a preprocess pipe', () => {
    expect(property(z.object({ n: z.preprocess((value) => value, z.number()).default(3) }), 'n')).toMatchObject({ default: 3 });
  });

  it('an object lists as required every key that rejects undefined, and none when all accept it', () => {
    expect(render(z.object({ a: z.string(), b: z.string().optional(), c: z.number().default(1) })).required).toEqual(['a']);
    expect(render(z.object({ a: z.string().optional() }))).not.toHaveProperty('required');
  });
});

describe('the finished document (ORB-2973)', () => {
  it('values that are not objects pass through, arrays are rewritten item by item', () => {
    expect(zodV3JsonSchema(null)).toBeNull();
    expect(zodV3JsonSchema(5)).toBe(5);
    expect(zodV3JsonSchema('text')).toBe('text');
    expect(zodV3JsonSchema([{ oneOf: [{ type: 'string' }] }, 'x'])).toEqual([{ anyOf: [{ type: 'string' }] }, 'x']);
  });

  it('a named string format loses the pattern zod 4 adds for it, and a pattern format loses the format name', () => {
    expect(zodV3JsonSchema({ type: 'string', format: 'email', pattern: '^x$' })).toEqual({ type: 'string', format: 'email' });
    expect(zodV3JsonSchema({ type: 'string', format: 'date-time', pattern: '^x$' })).toEqual({ type: 'string', format: 'date-time' });
    expect(zodV3JsonSchema({ type: 'string', format: 'regex', pattern: '^x$' })).toEqual({ type: 'string', pattern: '^x$' });
    expect(zodV3JsonSchema({ type: 'string', format: 'starts_with', pattern: '^x' })).toEqual({ type: 'string', pattern: '^x' });
    expect(zodV3JsonSchema({ type: 'string', format: 'ends_with', pattern: 'x$' })).toEqual({ type: 'string', pattern: 'x$' });
    expect(zodV3JsonSchema({ type: 'string', format: 'includes', pattern: 'x' })).toEqual({ type: 'string', pattern: 'x' });
    expect(zodV3JsonSchema({ type: 'string', format: 'hostname', pattern: '^x$' })).toEqual({ type: 'string', format: 'hostname', pattern: '^x$' });
  });

  it('a record of plain string keys loses propertyNames, a key with more rules keeps it', () => {
    expect(zodV3JsonSchema({ type: 'object', propertyNames: { type: 'string' }, additionalProperties: { type: 'number' } })).toEqual({ type: 'object', additionalProperties: { type: 'number' } });
    expect(zodV3JsonSchema({ type: 'object', propertyNames: { type: 'string', minLength: 3 }, additionalProperties: { type: 'number' } })).toMatchObject({ propertyNames: { type: 'string', minLength: 3 } });
  });

  it('an object with properties strips unknown keys unless it says otherwise', () => {
    expect(zodV3JsonSchema({ type: 'object', properties: { a: { type: 'string' } } })).toMatchObject({ additionalProperties: false });
    expect(zodV3JsonSchema({ type: 'object', properties: { a: { type: 'string' } }, additionalProperties: {} })).toMatchObject({ additionalProperties: true });
    expect(zodV3JsonSchema({ type: 'object', properties: { a: { type: 'string' } }, additionalProperties: { type: 'number' } })).toMatchObject({ additionalProperties: { type: 'number' } });
    expect(zodV3JsonSchema({ type: 'object', properties: { a: { type: 'string' } }, additionalProperties: true })).toMatchObject({ additionalProperties: true });
    expect(zodV3JsonSchema({ type: 'object' })).toEqual({ type: 'object' });
  });

  it('a discriminated union renders as anyOf', () => {
    const tagged = z.discriminatedUnion('t', [z.object({ t: z.literal('a') }), z.object({ t: z.literal('b') })]);
    const json = render(tagged);
    expect(json).toHaveProperty('anyOf');
    expect(json).not.toHaveProperty('oneOf');
  });
});
