/** ORB-2973 - what a client reads from zod in the shape zod 3 gave it: default messages through `z.config(zodV3Locale())`, generated JSON Schema through `zodV3JsonSchema()`. */
import type * as zod from 'zod';

type Issue = zod.core.$ZodRawIssue;
type Values = readonly unknown[];

function parsedType(data: unknown): string {
  switch (typeof data) {
    case 'number':
      return Number.isNaN(data) ? 'nan' : 'number';
    case 'object':
      if (Array.isArray(data)) return 'array';
      if (data === null) return 'null';
      if (typeof (data as { then?: unknown }).then === 'function' && typeof (data as { catch?: unknown }).catch === 'function') return 'promise';
      if (data instanceof Map) return 'map';
      if (data instanceof Set) return 'set';
      if (data instanceof Date) return 'date';
      return 'object';
    default:
      return typeof data;
  }
}

function joinValues(values: Values, separator = ' | '): string {
  return values.map((value) => (typeof value === 'string' ? `'${value}'` : String(value))).join(separator);
}

function schemaType(issue: Issue): string | undefined {
  return (issue.inst as { _zod?: { def?: { type?: string } } } | undefined)?._zod?.def?.type;
}

function isIntegerSchema(issue: Issue): boolean {
  const checks = (issue.inst as { _zod?: { def?: { checks?: Array<{ _zod: { def: { format?: string } } }> } } } | undefined)?._zod?.def?.checks;
  return !!checks?.some((check) => check._zod.def.format === 'safeint');
}

function invalidType(issue: Issue & { expected?: string }): string {
  const received = parsedType(issue.input);
  if (received === 'undefined') return 'Required';
  if (issue.expected === 'date' && received === 'date') return 'Invalid date';
  if (issue.expected === 'int' && received === 'number') return 'Expected integer, received float';
  if (issue.expected === 'number' && received === 'number') return isIntegerSchema(issue) ? 'Expected integer, received float' : 'Number must be finite';
  const expected = issue.expected === 'record' ? 'object' : issue.expected === 'tuple' ? 'array' : issue.expected === 'int' ? 'integer' : issue.expected;
  return `Expected ${expected}, received ${received}`;
}

function invalidValue(issue: Issue & { values: Values }): string {
  if (schemaType(issue) === 'literal') return `Invalid literal value, expected ${JSON.stringify(issue.values[0])}`;
  const received = parsedType(issue.input);
  if (received === 'undefined') return 'Required';
  const options = joinValues(issue.values);
  if (received !== 'string' && !(received === 'number' && issue.values.some((v) => typeof v === 'number'))) return `Expected ${options}, received ${received}`;
  return `Invalid enum value. Expected ${options}, received '${String(issue.input)}'`;
}

const SIZED: Record<string, string> = { int: 'number', number: 'number', bigint: 'bigint', string: 'string', array: 'array', date: 'date' };

function tooSmall(issue: Issue & { origin?: string; minimum: unknown; inclusive?: boolean; exact?: boolean }): string {
  const kind = SIZED[issue.origin ?? ''];
  const { exact, inclusive, minimum } = issue;
  if (kind === 'array') return `Array must contain ${exact ? 'exactly' : inclusive ? 'at least' : 'more than'} ${minimum} element(s)`;
  if (kind === 'string') return `String must contain ${exact ? 'exactly' : inclusive ? 'at least' : 'over'} ${minimum} character(s)`;
  if (kind === 'number' || kind === 'bigint') return `Number must be ${exact ? 'exactly equal to ' : inclusive ? 'greater than or equal to ' : 'greater than '}${minimum}`;
  if (kind === 'date') return `Date must be ${exact ? 'exactly equal to ' : inclusive ? 'greater than or equal to ' : 'greater than '}${new Date(Number(minimum))}`;
  return 'Invalid input';
}

function tooBig(issue: Issue & { origin?: string; maximum: unknown; inclusive?: boolean; exact?: boolean }): string {
  const kind = SIZED[issue.origin ?? ''];
  const { exact, inclusive, maximum } = issue;
  if (kind === 'array') return `Array must contain ${exact ? 'exactly' : inclusive ? 'at most' : 'less than'} ${maximum} element(s)`;
  if (kind === 'string') return `String must contain ${exact ? 'exactly' : inclusive ? 'at most' : 'under'} ${maximum} character(s)`;
  if (kind === 'number') return `Number must be ${exact ? 'exactly' : inclusive ? 'less than or equal to' : 'less than'} ${maximum}`;
  if (kind === 'bigint') return `BigInt must be ${exact ? 'exactly' : inclusive ? 'less than or equal to' : 'less than'} ${maximum}`;
  if (kind === 'date') return `Date must be ${exact ? 'exactly' : inclusive ? 'smaller than or equal to' : 'smaller than'} ${new Date(Number(maximum))}`;
  return 'Invalid input';
}

const FORMAT_NAMES: Record<string, string> = { guid: 'uuid', uuid: 'uuid', ipv4: 'ip', ipv6: 'ip', cidrv4: 'cidr', cidrv6: 'cidr' };

function includesPosition(issue: Issue & { position?: number }): number | undefined {
  if (typeof issue.position === 'number') return issue.position;
  const position = (issue.inst as { _zod?: { def?: { position?: unknown } } } | undefined)?._zod?.def?.position;
  return typeof position === 'number' ? position : undefined;
}

function invalidFormat(issue: Issue & { format: string; prefix?: string; suffix?: string; includes?: string; position?: number }): string {
  switch (issue.format) {
    case 'regex':
      return 'Invalid';
    case 'starts_with':
      return `Invalid input: must start with "${issue.prefix}"`;
    case 'ends_with':
      return `Invalid input: must end with "${issue.suffix}"`;
    case 'includes': {
      const message = `Invalid input: must include "${issue.includes}"`;
      const position = includesPosition(issue);
      return position === undefined ? message : `${message} at one or more positions greater than or equal to ${position}`;
    }
    default:
      return `Invalid ${FORMAT_NAMES[issue.format] ?? issue.format}`;
  }
}

/** The zod 3 English error map, read from zod 3.25.76 (`v3/locales/en.js`) and keyed by the zod 4 issue codes that replaced its codes. */
export const zodV3Messages: zod.core.$ZodErrorMap = (issue) => {
  switch (issue.code) {
    case 'invalid_type':
      return invalidType(issue);
    case 'invalid_value':
      return invalidValue(issue);
    case 'unrecognized_keys':
      return `Unrecognized key(s) in object: ${joinValues(issue.keys, ', ')}`;
    case 'invalid_union': {
      const options = (issue as { options?: Values }).options;
      return options?.length ? `Invalid discriminator value. Expected ${joinValues(options)}` : 'Invalid input';
    }
    case 'invalid_format':
      return invalidFormat(issue);
    case 'too_small':
      return tooSmall(issue);
    case 'too_big':
      return tooBig(issue);
    case 'not_multiple_of':
      return `Number must be a multiple of ${issue.divisor}`;
    case 'invalid_key':
      return issue.issues[0]?.message ?? 'Invalid input';
    default:
      return 'Invalid input';
  }
};

/** A locale for `z.config()`, as `z.locales.en()` is one. */
export function zodV3Locale(): { localeError: zod.core.$ZodErrorMap } {
  return { localeError: zodV3Messages };
}

type JsonNode = Record<string, unknown>;
type SchemaDef = { type: string; shape?: Record<string, zod.core.$ZodType>; defaultValue?: unknown; checks?: zod.core.$ZodCheck<never>[] };

/**
 * A `toJSONSchema` override that renders what zod-to-json-schema rendered under zod 3: an object lists as required every key whose schema
 * rejects `undefined`, an integer drops the safe-integer range `.int()` implies, a default stays on a schema whose inner type is a `z.preprocess()` pipe, `undefined` reads `{ not: {} }` and `void` `{}`.
 */
export function zodV3JsonSchemaOverride({ zodSchema, jsonSchema }: { zodSchema: zod.core.$ZodType; jsonSchema: JsonNode }): void {
  const def = zodSchema._zod.def as SchemaDef;
  if (def.type === 'undefined' || def.type === 'void') {
    for (const key of Object.keys(jsonSchema)) delete jsonSchema[key];
    if (def.type === 'undefined') jsonSchema.not = {};
    return;
  }
  if (def.type === 'number') dropImpliedSafeRange(def, jsonSchema);
  if (def.type === 'default' && !('default' in jsonSchema) && def.defaultValue !== undefined) jsonSchema.default = JSON.parse(JSON.stringify(def.defaultValue));
  if (def.type === 'object' && def.shape && jsonSchema.properties) {
    const required = Object.keys(def.shape).filter((key) => !acceptsUndefined(def.shape?.[key]));
    if (required.length) jsonSchema.required = required;
    else delete jsonSchema.required;
  }
}

function dropImpliedSafeRange(def: SchemaDef, jsonSchema: JsonNode): void {
  const stated = new Set((def.checks ?? []).map((check) => Number((check._zod.def as { value?: unknown }).value)));
  if (jsonSchema.maximum === Number.MAX_SAFE_INTEGER && !stated.has(Number.MAX_SAFE_INTEGER)) delete jsonSchema.maximum;
  if (jsonSchema.minimum === Number.MIN_SAFE_INTEGER && !stated.has(Number.MIN_SAFE_INTEGER)) delete jsonSchema.minimum;
}

function acceptsUndefined(schema: zod.core.$ZodType | undefined): boolean {
  const result = schema?.['~standard'].validate(undefined);
  return !!result && !(result instanceof Promise) && !result.issues;
}

const NAMED_FORMATS = new Set(['uuid', 'email', 'date-time', 'date', 'time', 'duration', 'ipv4', 'ipv6', 'uri']);
const PATTERN_FORMATS = new Set(['starts_with', 'ends_with', 'includes', 'regex']);

function isPlainStringKey(value: unknown): boolean {
  return !!value && typeof value === 'object' && Object.keys(value).length === 1 && (value as JsonNode).type === 'string';
}

function isEmptyObject(value: unknown): boolean {
  return !!value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0;
}

/**
 * A JSON Schema from zod 4 in the shape zod-to-json-schema gave it under zod 3: a named string format without the pattern zod 4 adds for it,
 * a prefix, suffix or substring check as its pattern alone, a record of string keys without `propertyNames`, a discriminated union as `anyOf`, and an object with properties that strips unknown keys with `additionalProperties: false`.
 */
export function zodV3JsonSchema<T>(schema: T): T {
  if (Array.isArray(schema)) return schema.map((item) => zodV3JsonSchema(item)) as T;
  if (!schema || typeof schema !== 'object') return schema;
  const node: JsonNode = {};
  for (const [key, value] of Object.entries(schema as JsonNode)) node[key === 'oneOf' ? 'anyOf' : key] = zodV3JsonSchema(value);
  if (typeof node.format === 'string' && NAMED_FORMATS.has(node.format) && typeof node.pattern === 'string') delete node.pattern;
  if (typeof node.format === 'string' && PATTERN_FORMATS.has(node.format)) delete node.format;
  if (isPlainStringKey(node.propertyNames)) delete node.propertyNames;
  if (node.type === 'object' && node.properties && typeof node.properties === 'object') {
    if (!('additionalProperties' in node)) node.additionalProperties = false;
    else if (isEmptyObject(node.additionalProperties)) node.additionalProperties = true;
  }
  return node as T;
}
