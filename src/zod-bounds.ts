/** ORB-2670, ORB-2973 - GHSA-mrhx-c7xc-m3w5: zod 4.6.6 and newer fail an array over a leading `.max()` / `.length()` with one issue before any element is parsed; `boundedRecord` does the same for a record over its key limit. */
import * as zod from 'zod';

type AnyDef = Record<string, unknown> & { type?: string; checks?: zod.core.$ZodCheck<never>[] };
type RecordKey = zod.core.$ZodRecordKey;
type BoundedKey<K extends RecordKey> = K extends { _zod: { def: { type: 'enum' | 'literal' } } } ? K & zod.core.$partial : K;
type BoundedRecordDef = zod.core.$ZodRecordDef & { maxKeys: number };

function exceedsKeyLimit(data: unknown, maxKeys: number): boolean {
  return !!data && typeof data === 'object' && !Array.isArray(data) && Object.keys(data).length > maxKeys;
}

const initRecord: (inst: zod.ZodRecord, def: BoundedRecordDef) => void = zod.ZodRecord.init;

type RecordPayload = zod.core.ParsePayload;

/** A key outside an enum or literal key set is one `invalid_value` issue at that key, as zod 3 read it, where zod 4 reports the record's unrecognized keys. */
function readUnrecognizedKeysAsInvalid(payload: RecordPayload, inst: zod.ZodRecord, keyType: zod.core.$ZodType, values: Set<zod.core.util.Primitive>): RecordPayload {
  payload.issues = payload.issues.flatMap((issue) => (issue.code === 'unrecognized_keys' && issue.inst === inst
    ? issue.keys.map((key): zod.core.$ZodRawIssue => ({ code: 'invalid_value', values: [...values], input: key, path: [key], inst: keyType, continue: true }))
    : [issue]));
  return payload;
}

const ZodBoundedRecord = zod.core.$constructor('ZodBoundedRecord', (inst: zod.ZodRecord, def: BoundedRecordDef) => {
  initRecord(inst, def);
  const parseRecord = inst._zod.parse;
  const keyValues = (def.keyType as { _zod: { values?: Set<zod.core.util.Primitive> } })._zod.values;
  inst._zod.parse = (payload, ctx) => {
    if (!exceedsKeyLimit(payload.value, def.maxKeys)) {
      const parsed = parseRecord(payload, ctx);
      if (!keyValues) return parsed;
      return parsed instanceof Promise
        ? parsed.then((done) => readUnrecognizedKeysAsInvalid(done, inst, def.keyType, keyValues))
        : readUnrecognizedKeysAsInvalid(parsed, inst, def.keyType, keyValues);
    }
    payload.issues.push({
      code: 'custom',
      message: `Object must contain at most ${def.maxKeys} key(s)`,
      params: { maxKeys: def.maxKeys },
      input: payload.value,
      inst,
      continue: false,
    });
    return payload;
  };
  const toJsonSchema = inst._zod.processJSONSchema;
  const keys = keyValues;
  inst._zod.processJSONSchema = (ctx, json, params) => {
    toJsonSchema?.(ctx, json, params);
    json.maxProperties = def.maxKeys;
    if (!keys) return;
    json.properties = Object.fromEntries([...keys].map((key) => [String(key), json.additionalProperties as zod.core.JSONSchema.JSONSchema]));
    json.required = [...keys].map(String);
    json.additionalProperties = false;
  };
});

/** A record of at most `maxKeys` keys; an enum or literal key stays partial and is documented with one required property per key, as zod-to-json-schema documented it under zod 3. */
export function boundedRecord<K extends RecordKey, V extends zod.core.$ZodType>(
  keySchema: K,
  valueSchema: V,
  maxKeys: number,
): zod.ZodRecord<BoundedKey<K>, V> {
  const def: BoundedRecordDef = { type: 'record', keyType: keySchema, valueType: valueSchema, partial: true, maxKeys };
  return new ZodBoundedRecord(def) as unknown as zod.ZodRecord<BoundedKey<K>, V>;
}

function defOf(schema: unknown): AnyDef {
  return ((schema as { _zod?: { def?: AnyDef } })?._zod?.def ?? {}) as AnyDef;
}

function isPassthrough(schema: unknown): boolean {
  const type = defOf(schema).type;
  return type === 'unknown' || type === 'any';
}

function hasSizeCap(def: AnyDef): boolean {
  return zod.core.util.sizeCaps(def.checks).length > 0;
}

function entriesCanFail(def: AnyDef): boolean {
  const key = defOf(def.keyType);
  const plainKey = key.type === 'string' && !key.checks?.length;
  return !(isPassthrough(def.valueType) && plainKey);
}

/** Paths of every array, record, catchall, set, map and tuple rest whose unbounded entries can each fail; an array or set counts as bounded only when its size cap leads its checks, the only place zod enforces it before the elements. */
export function findUnboundedCollections(schema: unknown, path = '$'): string[] {
  const found: string[] = [];
  const seen = new Set<unknown>();
  const walk = (node: unknown, at: string): void => {
    if (!node || typeof node !== 'object' || seen.has(node)) return;
    seen.add(node);
    const def = defOf(node);
    switch (def.type) {
      case 'array':
        if (!hasSizeCap(def) && !isPassthrough(def.element)) found.push(at);
        walk(def.element, `${at}[]`);
        return;
      case 'record':
        if (def.maxKeys === undefined && entriesCanFail(def)) found.push(at);
        walk(def.keyType, `${at}{key}`);
        walk(def.valueType, `${at}{}`);
        return;
      case 'set':
        if (!hasSizeCap(def)) found.push(at);
        walk(def.valueType, `${at}[]`);
        return;
      case 'map':
        found.push(at);
        walk(def.keyType, `${at}{key}`);
        walk(def.valueType, `${at}{}`);
        return;
      case 'tuple':
        (def.items as unknown[]).forEach((item, i) => walk(item, `${at}[${i}]`));
        if (def.rest) {
          found.push(`${at}[...]`);
          walk(def.rest, `${at}[...]`);
        }
        return;
      case 'object': {
        for (const [key, child] of Object.entries(def.shape as Record<string, unknown>)) walk(child, `${at}.${key}`);
        if (def.catchall && defOf(def.catchall).type !== 'never') {
          if (!isPassthrough(def.catchall)) found.push(`${at}.*`);
          walk(def.catchall, `${at}.*`);
        }
        return;
      }
      case 'union':
        for (const option of def.options as Iterable<unknown>) walk(option, at);
        return;
      case 'intersection':
        walk(def.left, at);
        walk(def.right, at);
        return;
      case 'lazy':
        walk((def.getter as () => unknown)(), at);
        return;
      case 'pipe':
        walk(def.in, at);
        walk(def.out, at);
        return;
      case 'optional':
      case 'nullable':
      case 'default':
      case 'prefault':
      case 'nonoptional':
      case 'catch':
      case 'readonly':
      case 'promise':
      case 'success':
        walk(def.innerType, at);
        return;
      default:
        return;
    }
  };
  walk(schema, path);
  return found;
}
