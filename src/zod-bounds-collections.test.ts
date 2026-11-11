/**
 * ORB-2670, ORB-2973 - `findUnboundedCollections` names every collection whose entries can fail without a size cap in front of them, and `boundedRecord` caps a record's keys before any entry is parsed.
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { boundedRecord, findUnboundedCollections } from './zod-bounds.js';
import { zodV3Locale } from './zod-v3-compat.js';

z.config(zodV3Locale());

describe('findUnboundedCollections (ORB-2973)', () => {
  it.each([
    ['an array without a cap', z.array(z.string()), ['$']],
    ['an array with a leading max', z.array(z.string()).max(5), []],
    ['an array with an exact length', z.array(z.string()).length(5), []],
    ['an array of anything', z.array(z.unknown()), []],
    ['an array of an uncapped array under a cap', z.array(z.array(z.string())).max(3), ['$[]']],
    ['an uncapped record with entries that can fail', z.record(z.string(), z.number()), ['$']],
    ['a record of anything under plain string keys', z.record(z.string(), z.unknown()), []],
    ['a record of anything under a key with a rule', z.record(z.string().min(2), z.unknown()), ['$']],
    ['a record of anything under enum keys', z.record(z.enum(['a']), z.unknown()), ['$']],
    ['a bounded record', boundedRecord(z.string(), z.number(), 5), []],
    ['a set without a cap', z.set(z.string()), ['$']],
    ['a set with a max', z.set(z.string()).max(3), []],
    ['a map', z.map(z.string(), z.string()), ['$']],
    ['an array inside a tuple', z.tuple([z.string(), z.array(z.string())]), ['$[1]']],
    ['a tuple with a rest element', z.tuple([z.string()], z.number()), ['$[...]']],
    ['an object with a typed catchall', z.object({ a: z.string() }).catchall(z.string()), ['$.*']],
    ['an object with an unknown catchall', z.object({ a: z.string() }).catchall(z.unknown()), []],
    ['a strict object', z.strictObject({ a: z.string() }), []],
    ['an array under an object key', z.object({ a: z.array(z.string()) }), ['$.a']],
    ['an array inside a union', z.union([z.array(z.string()), z.string()]), ['$']],
    ['an array on each side of an intersection', z.intersection(z.object({ a: z.array(z.string()) }), z.object({ b: z.array(z.string()) })), ['$.a', '$.b']],
    ['an array on the input side of a pipe', z.array(z.string()).pipe(z.array(z.string()).max(3)), ['$']],
    ['a plain string', z.string(), []],
  ])('%s', (_name, schema, paths) => {
    expect(findUnboundedCollections(schema)).toEqual(paths);
  });

  it.each([
    ['optional', (inner: z.core.$ZodType) => z.optional(inner)],
    ['nullable', (inner: z.core.$ZodType) => z.nullable(inner)],
    ['default', (inner: z.core.$ZodType) => z._default(inner as z.ZodType, [] as never)],
    ['prefault', (inner: z.core.$ZodType) => z.prefault(inner as z.ZodType, [] as never)],
    ['nonoptional', (inner: z.core.$ZodType) => z.nonoptional(inner)],
    ['catch', (inner: z.core.$ZodType) => z.catch(inner as z.ZodType, [] as never)],
    ['readonly', (inner: z.core.$ZodType) => z.readonly(inner)],
    ['promise', (inner: z.core.$ZodType) => z.promise(inner)],
    ['success', (inner: z.core.$ZodType) => z.success(inner)],
  ])('looks through %s', (_name, wrap) => {
    expect(findUnboundedCollections(wrap(z.array(z.string())))).toEqual(['$']);
  });

  it('follows a lazy schema once, however recursive it is', () => {
    type Tree = { children: Tree[] };
    const tree: z.ZodType<Tree> = z.lazy(() => z.object({ children: z.array(tree) }));
    expect(findUnboundedCollections(tree)).toEqual(['$.children']);
  });

  it('starts every path at the name it is given, and ignores what is not a schema', () => {
    expect(findUnboundedCollections(z.object({ rows: z.array(z.string()) }), 'tool_name')).toEqual(['tool_name.rows']);
    expect(findUnboundedCollections(undefined)).toEqual([]);
    expect(findUnboundedCollections('text')).toEqual([]);
  });
});

describe('boundedRecord (ORB-2973)', () => {
  it('parses a record of plain string keys as zod does and reads a key set as partial', () => {
    expect(boundedRecord(z.string(), z.number(), 5).parse({ a: 1, b: 2 })).toEqual({ a: 1, b: 2 });
    expect(boundedRecord(z.enum(['a', 'b']), z.number(), 5).parse({ a: 1 })).toEqual({ a: 1 });
    expect(boundedRecord(z.literal('x'), z.number(), 5).parse({ x: 1 })).toEqual({ x: 1 });
  });

  it('refuses an object over its key limit with one issue and a non-object as zod does', () => {
    const schema = boundedRecord(z.string(), z.number(), 2);
    expect(schema.safeParse({ a: 1, b: 2, c: 3 }).error?.issues).toEqual([expect.objectContaining({ code: 'custom', message: 'Object must contain at most 2 key(s)', params: { maxKeys: 2 } })]);
    expect(schema.safeParse([1, 2, 3]).error?.issues[0]?.message).toBe('Expected object, received array');
    expect(schema.safeParse(null).error?.issues[0]?.message).toBe('Expected object, received null');
  });

  it('reads a key outside an enum as one invalid enum value at that key while the entries are parsed asynchronously', async () => {
    const schema = boundedRecord(z.enum(['a', 'b']), z.string().refine(async (value) => value.length > 0), 5);
    const result = await schema.safeParseAsync({ a: 'x', c: 'y' });
    expect(result.error?.issues.map((issue) => [issue.path, issue.message])).toEqual([[['c'], "Invalid enum value. Expected 'a' | 'b', received 'c'"]]);
    expect((await schema.safeParseAsync({ a: 'x' })).success).toBe(true);
  });

  it('documents the key limit, and a key set as one required property per key', () => {
    expect(z.toJSONSchema(boundedRecord(z.string(), z.number(), 5))).toMatchObject({ type: 'object', maxProperties: 5, additionalProperties: { type: 'number' } });
    const keyed = z.toJSONSchema(boundedRecord(z.enum(['a', 'b']), z.number(), 5)) as Record<string, unknown>;
    expect(keyed).toMatchObject({ maxProperties: 5, required: ['a', 'b'], additionalProperties: false });
    expect(Object.keys(keyed.properties as object)).toEqual(['a', 'b']);
  });
});
