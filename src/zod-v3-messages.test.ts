/**
 * ORB-2973 - every default message the MCP server reads from zod is worded as zod 3.25.76 worded it (`v3/locales/en.js`).
 * The first table parses real schemas; the second hands the message map raw issues for the forms zod 4 never produces itself.
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { zodV3Locale, zodV3Messages } from './zod-v3-compat.js';

z.config(zodV3Locale());

const messages = (schema: z.core.$ZodType, input: unknown): string[] => z.safeParse(schema, input).error?.issues.map((issue) => issue.message) ?? [];
const worded = (issue: z.core.$ZodRawIssue): unknown => zodV3Messages(issue);

describe('the type a message names for the received value (ORB-2973)', () => {
  it.each([
    ['NaN', Number.NaN, 'nan'],
    ['an array', [], 'array'],
    ['null', null, 'null'],
    ['a promise', Promise.resolve(1), 'promise'],
    ['a Map', new Map(), 'map'],
    ['a Set', new Set(), 'set'],
    ['a Date', new Date(0), 'date'],
    ['an object with only a then', { then: () => 1 }, 'object'],
    ['a plain object', {}, 'object'],
    ['a boolean', true, 'boolean'],
    ['a bigint', 1n, 'bigint'],
    ['a function', () => 1, 'function'],
    ['a symbol', Symbol('s'), 'symbol'],
    ['a number', 5, 'number'],
  ])('%s reads as %s', (_name, input, received) => {
    expect(messages(z.string(), input)).toEqual([`Expected string, received ${received}`]);
  });

  it('a missing value reads Required', () => {
    expect(messages(z.string(), undefined)).toEqual(['Required']);
    expect(messages(z.enum(['a', 'b']), undefined)).toEqual(['Required']);
  });
});

describe('invalid_type and invalid_value (ORB-2973)', () => {
  it.each([
    ['an invalid date', z.date(), new Date('not a date'), 'Invalid date'],
    ['a string for a date', z.date(), 5, 'Expected date, received number'],
    ['a float for an integer', z.number().int(), 1.5, 'Expected integer, received float'],
    ['a string for an integer', z.number().int(), 'a', 'Expected number, received string'],
    ['Infinity for an integer', z.number().int(), Number.POSITIVE_INFINITY, 'Expected integer, received float'],
    ['Infinity for a finite number', z.number().finite(), Number.POSITIVE_INFINITY, 'Number must be finite'],
    ['Infinity for a bounded number', z.number().min(1), Number.POSITIVE_INFINITY, 'Number must be finite'],
    ['a string for a record', z.record(z.string(), z.number()), 'x', 'Expected object, received string'],
    ['a string for a tuple', z.tuple([z.string()]), 'x', 'Expected array, received string'],
    ['a wrong string literal', z.literal('a'), 'b', 'Invalid literal value, expected "a"'],
    ['a wrong numeric literal', z.literal(1), 2, 'Invalid literal value, expected 1'],
    ['a string outside an enum', z.enum(['a', 'b']), 'c', "Invalid enum value. Expected 'a' | 'b', received 'c'"],
    ['an object for an enum', z.enum(['a', 'b']), {}, "Expected 'a' | 'b', received object"],
    ['a number for a string enum', z.enum(['a', 'b']), 5, "Expected 'a' | 'b', received number"],
    ['a number outside a numeric enum', z.enum({ One: 1, Two: 2 }), 3, "Invalid enum value. Expected 1 | 2, received '3'"],
    ['a string for a numeric enum', z.enum({ One: 1, Two: 2 }), 'x', "Invalid enum value. Expected 1 | 2, received 'x'"],
  ])('%s', (_name, schema, input, message) => {
    expect(messages(schema, input)).toEqual([message]);
  });

  it('a strict object names every unknown key', () => {
    expect(messages(z.strictObject({ a: z.string() }), { a: 'x', b: 1, c: 2 })).toEqual(["Unrecognized key(s) in object: 'b', 'c'"]);
  });

  it('a discriminated union names the allowed values, a plain union reads Invalid input', () => {
    const tagged = z.discriminatedUnion('t', [z.object({ t: z.literal('a') }), z.object({ t: z.literal('b') })]);
    expect(messages(tagged, { t: 'c' })).toEqual(["Invalid discriminator value. Expected 'a' | 'b'"]);
    expect(messages(z.union([z.string(), z.number()]), true)).toEqual(['Invalid input']);
  });

  it('a refusal without its own wording reads Invalid input', () => {
    expect(messages(z.string().refine(() => false), 'a')).toEqual(['Invalid input']);
  });
});

describe('string formats (ORB-2973)', () => {
  it.each([
    ['a pattern', z.string().regex(/^a$/), 'b', 'Invalid'],
    ['a prefix', z.string().startsWith('ab'), 'x', 'Invalid input: must start with "ab"'],
    ['a suffix', z.string().endsWith('ab'), 'x', 'Invalid input: must end with "ab"'],
    ['a substring', z.string().includes('ab'), 'x', 'Invalid input: must include "ab"'],
    ['a substring from a position', z.string().includes('ab', { position: 2 }), 'x', 'Invalid input: must include "ab" at one or more positions greater than or equal to 2'],
    ['an address', z.string().email(), 'x', 'Invalid email'],
    ['a uuid', z.string().check(z.uuid()), 'x', 'Invalid uuid'],
    ['a guid', z.guid(), 'x', 'Invalid uuid'],
    ['an ipv4 address', z.string().check(z.ipv4()), 'x', 'Invalid ip'],
    ['an ipv6 address', z.string().check(z.ipv6()), 'x', 'Invalid ip'],
    ['an ipv4 range', z.string().check(z.cidrv4()), 'x', 'Invalid cidr'],
    ['an ipv6 range', z.string().check(z.cidrv6()), 'x', 'Invalid cidr'],
    ['a format zod 4 names itself', z.string().check(z.emoji()), 'x', 'Invalid emoji'],
  ])('%s', (_name, schema, input, message) => {
    expect(messages(schema, input)).toEqual([message]);
  });

  it('a raw issue carries the position of a substring check', () => {
    expect(worded({ code: 'invalid_format', format: 'includes', includes: 'ab', position: 3, input: 'x' })).toBe('Invalid input: must include "ab" at one or more positions greater than or equal to 3');
    expect(worded({ code: 'invalid_format', format: 'includes', includes: 'ab', input: 'x' })).toBe('Invalid input: must include "ab"');
  });
});

describe('sizes and bounds (ORB-2973)', () => {
  it.each([
    ['an array under its minimum', z.array(z.string()).min(2), ['a'], 'Array must contain at least 2 element(s)'],
    ['an array over its maximum', z.array(z.string()).max(1), ['a', 'b'], 'Array must contain at most 1 element(s)'],
    ['an array under an exact length', z.array(z.string()).length(2), ['a'], 'Array must contain exactly 2 element(s)'],
    ['an array over an exact length', z.array(z.string()).length(1), ['a', 'b'], 'Array must contain exactly 1 element(s)'],
    ['a string under its minimum', z.string().min(3), 'a', 'String must contain at least 3 character(s)'],
    ['a string over its maximum', z.string().max(1), 'abc', 'String must contain at most 1 character(s)'],
    ['a string under an exact length', z.string().length(3), 'a', 'String must contain exactly 3 character(s)'],
    ['a string over an exact length', z.string().length(1), 'abc', 'String must contain exactly 1 character(s)'],
    ['a number under its minimum', z.number().min(3), 1, 'Number must be greater than or equal to 3'],
    ['a number at an exclusive minimum', z.number().gt(3), 3, 'Number must be greater than 3'],
    ['a number over its maximum', z.number().max(3), 5, 'Number must be less than or equal to 3'],
    ['a number at an exclusive maximum', z.number().lt(3), 3, 'Number must be less than 3'],
    ['a bigint under its minimum', z.bigint().min(3n), 1n, 'Number must be greater than or equal to 3'],
    ['a bigint over its maximum', z.bigint().max(3n), 5n, 'BigInt must be less than or equal to 3'],
    ['a number off its multiple', z.number().multipleOf(5), 3, 'Number must be a multiple of 5'],
    ['a record key under its minimum', z.record(z.string().min(3), z.number()), { a: 1 }, 'String must contain at least 3 character(s)'],
  ])('%s', (_name, schema, input, message) => {
    expect(messages(schema, input)).toEqual([message]);
  });

  it('a date names the bound as zod 3 printed it', () => {
    expect(messages(z.date().min(new Date(1000)), new Date(0))).toEqual([`Date must be greater than or equal to ${new Date(1000)}`]);
    expect(messages(z.date().max(new Date(0)), new Date(1000))).toEqual([`Date must be smaller than or equal to ${new Date(0)}`]);
  });

  it.each([
    ['array', true, undefined, 'Array must contain exactly 2 element(s)'],
    ['array', false, true, 'Array must contain at least 2 element(s)'],
    ['array', false, false, 'Array must contain more than 2 element(s)'],
    ['string', true, undefined, 'String must contain exactly 2 character(s)'],
    ['string', false, true, 'String must contain at least 2 character(s)'],
    ['string', false, false, 'String must contain over 2 character(s)'],
    ['number', true, undefined, 'Number must be exactly equal to 2'],
    ['number', false, true, 'Number must be greater than or equal to 2'],
    ['number', false, false, 'Number must be greater than 2'],
    ['bigint', true, undefined, 'Number must be exactly equal to 2'],
    ['bigint', false, true, 'Number must be greater than or equal to 2'],
    ['bigint', false, false, 'Number must be greater than 2'],
    ['date', true, undefined, `Date must be exactly equal to ${new Date(2)}`],
    ['date', false, true, `Date must be greater than or equal to ${new Date(2)}`],
    ['date', false, false, `Date must be greater than ${new Date(2)}`],
    ['set', false, true, 'Invalid input'],
  ])('a raw too_small issue of a %s (exact %s, inclusive %s) reads "%s"', (origin, exact, inclusive, message) => {
    expect(worded({ code: 'too_small', origin, minimum: 2, exact, inclusive, input: undefined })).toBe(message);
  });

  it.each([
    ['array', true, undefined, 'Array must contain exactly 2 element(s)'],
    ['array', false, true, 'Array must contain at most 2 element(s)'],
    ['array', false, false, 'Array must contain less than 2 element(s)'],
    ['string', true, undefined, 'String must contain exactly 2 character(s)'],
    ['string', false, true, 'String must contain at most 2 character(s)'],
    ['string', false, false, 'String must contain under 2 character(s)'],
    ['number', true, undefined, 'Number must be exactly 2'],
    ['number', false, true, 'Number must be less than or equal to 2'],
    ['number', false, false, 'Number must be less than 2'],
    ['bigint', true, undefined, 'BigInt must be exactly 2'],
    ['bigint', false, true, 'BigInt must be less than or equal to 2'],
    ['bigint', false, false, 'BigInt must be less than 2'],
    ['date', true, undefined, `Date must be exactly ${new Date(2)}`],
    ['date', false, true, `Date must be smaller than or equal to ${new Date(2)}`],
    ['date', false, false, `Date must be smaller than ${new Date(2)}`],
    ['set', false, true, 'Invalid input'],
  ])('a raw too_big issue of a %s (exact %s, inclusive %s) reads "%s"', (origin, exact, inclusive, message) => {
    expect(worded({ code: 'too_big', origin, maximum: 2, exact, inclusive, input: undefined })).toBe(message);
  });

  it('a raw issue of an origin that has no size wording reads Invalid input', () => {
    expect(worded({ code: 'too_small', origin: 'file', minimum: 2, input: undefined })).toBe('Invalid input');
    expect(worded({ code: 'too_big', origin: 'file', maximum: 2, input: undefined })).toBe('Invalid input');
  });
});

describe('keys, unions and the rest (ORB-2973)', () => {
  it('an invalid key reads the message of its own first issue, or Invalid input without one', () => {
    expect(worded({ code: 'invalid_key', origin: 'record', issues: [{ code: 'custom', message: 'bad key', input: 'k', path: [] }], input: { k: 1 } })).toBe('bad key');
    expect(worded({ code: 'invalid_key', origin: 'record', issues: [], input: { k: 1 } })).toBe('Invalid input');
  });

  it('a union issue lists the options it carries, and reads Invalid input without them', () => {
    const withOptions = { code: 'invalid_union' as const, errors: [], input: 'x', options: ['a', 'b'] };
    const withoutOptions = { code: 'invalid_union' as const, errors: [], input: 'x', options: [] };
    expect(worded(withOptions)).toBe("Invalid discriminator value. Expected 'a' | 'b'");
    expect(worded(withoutOptions)).toBe('Invalid input');
    expect(worded({ code: 'invalid_union', errors: [], input: 'x' })).toBe('Invalid input');
  });

  it('a raw custom issue reads Invalid input', () => {
    expect(worded({ code: 'custom', input: 'x' })).toBe('Invalid input');
  });

  it('a raw invalid_type issue of a literal received value reads the wording of its kind', () => {
    expect(worded({ code: 'invalid_type', expected: 'string', input: 7 })).toBe('Expected string, received number');
    expect(worded({ code: 'invalid_type', expected: 'int', input: 7 })).toBe('Expected integer, received float');
    expect(worded({ code: 'invalid_type', expected: 'int', input: 'x' })).toBe('Expected integer, received string');
    expect(worded({ code: 'invalid_type', expected: 'number', input: 7 })).toBe('Number must be finite');
    expect(worded({ code: 'invalid_type', expected: 'date', input: new Date(0) })).toBe('Invalid date');
  });
});
