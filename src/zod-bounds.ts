/** ORB-2670 - GHSA-mrhx-c7xc-m3w5: an array over its `.max()` / `.length()` or a `boundedRecord` over its key limit fails with one issue before any element is parsed. */
import * as zod from 'zod';
import type { KeySchema, ParseInput, ParseReturnType, ZodType, ZodTypeAny } from 'zod';

type ZodRuntime = Pick<typeof zod, 'INVALID' | 'ZodArray' | 'ZodIssueCode' | 'ZodRecord' | 'addIssueToContext'>;
type Limit = { value: number; message?: string } | null;
type ArrayInternals = { _def: { maxLength: Limit; exactLength: Limit }; _getOrReturnCtx: ZodType['_getOrReturnCtx'] };
type RecordInternals = { _def: { maxKeys?: number }; _getOrReturnCtx: ZodType['_getOrReturnCtx'] };
type ParseFn<T> = (this: T, input: ParseInput) => ParseReturnType<unknown>;

const INSTALLED = Symbol.for('orboto.zodCollectionBounds');

function exceedsKeyLimit(data: unknown, maxKeys: number): boolean {
  return !!data && typeof data === 'object' && !Array.isArray(data) && Object.keys(data).length > maxKeys;
}

/** Patches one zod module instance; a CommonJS program that also loads this ESM module passes its own `zod` too. */
export function installZodCollectionBounds(runtime: ZodRuntime = zod): void {
  const { INVALID, ZodArray, ZodIssueCode, ZodRecord, addIssueToContext } = runtime;
  const arrayProto = ZodArray.prototype as unknown as { _parse: ParseFn<ArrayInternals>; [INSTALLED]?: true };
  if (arrayProto[INSTALLED]) return;
  const parseArray = arrayProto._parse;
  arrayProto._parse = function boundedArrayParse(this: ArrayInternals, input: ParseInput) {
    const limit = this._def.exactLength ?? this._def.maxLength;
    if (limit && Array.isArray(input.data) && input.data.length > limit.value) {
      addIssueToContext(this._getOrReturnCtx(input), {
        code: ZodIssueCode.too_big,
        maximum: limit.value,
        type: 'array',
        inclusive: true,
        exact: limit === this._def.exactLength,
        message: limit.message,
      });
      return INVALID;
    }
    return parseArray.call(this, input);
  };
  arrayProto[INSTALLED] = true;

  const recordProto = ZodRecord.prototype as unknown as { _parse: ParseFn<RecordInternals>; [INSTALLED]?: true };
  const parseRecord = recordProto._parse;
  recordProto._parse = function boundedRecordParse(this: RecordInternals, input: ParseInput) {
    const maxKeys = this._def.maxKeys;
    if (maxKeys !== undefined && exceedsKeyLimit(input.data, maxKeys)) {
      addIssueToContext(this._getOrReturnCtx(input), {
        code: ZodIssueCode.custom,
        message: `Object must contain at most ${maxKeys} key(s)`,
        params: { maxKeys },
      });
      return INVALID;
    }
    return parseRecord.call(this, input);
  };
  recordProto[INSTALLED] = true;
}

type InstalledRuntime = Pick<ZodRuntime, 'ZodArray' | 'ZodRecord'>;

export function zodCollectionBoundsInstalled(runtime: InstalledRuntime = zod): boolean {
  const marked = (proto: unknown) => (proto as { [INSTALLED]?: true })[INSTALLED] === true;
  return marked(runtime.ZodArray.prototype) && marked(runtime.ZodRecord.prototype);
}

/** Throws unless this module's zod and every passed instance carry the installed bounds. */
export function assertZodCollectionBounds(...runtimes: InstalledRuntime[]): void {
  if ([zod, ...runtimes].every((runtime) => zodCollectionBoundsInstalled(runtime))) return;
  throw new Error('zod collection bounds are not installed: call installZodCollectionBounds() for the ESM zod and installZodCollectionBounds(zod) for a CommonJS one before routes or tools register (ORB-2670, GHSA-mrhx-c7xc-m3w5).');
}

export function boundedRecord<K extends KeySchema, V extends ZodTypeAny>(
  keySchema: K,
  valueSchema: V,
  maxKeys: number,
): zod.ZodRecord<K, V> {
  const base = zod.ZodRecord.create(keySchema, valueSchema);
  return new zod.ZodRecord({ ...base._def, maxKeys } as typeof base._def);
}

type AnyDef = Record<string, unknown> & { typeName?: string };

function defOf(schema: unknown): AnyDef {
  return ((schema as { _def?: AnyDef })?._def ?? {}) as AnyDef;
}

function isPassthrough(schema: unknown): boolean {
  const typeName = defOf(schema).typeName;
  return typeName === 'ZodUnknown' || typeName === 'ZodAny';
}

function entriesCanFail(def: AnyDef): boolean {
  const key = defOf(def.keyType);
  const plainKey = key.typeName === 'ZodString' && (key.checks as unknown[] | undefined)?.length === 0;
  return !(isPassthrough(def.valueType) && plainKey);
}

/** Paths of every array, record, catchall, set, map and tuple rest whose unbounded entries can each fail. */
export function findUnboundedCollections(schema: unknown, path = '$'): string[] {
  const found: string[] = [];
  const seen = new Set<unknown>();
  const walk = (node: unknown, at: string): void => {
    if (!node || typeof node !== 'object' || seen.has(node)) return;
    seen.add(node);
    const def = defOf(node);
    switch (def.typeName) {
      case 'ZodArray':
        if (!def.maxLength && !def.exactLength && !isPassthrough(def.type)) found.push(at);
        walk(def.type, `${at}[]`);
        return;
      case 'ZodRecord':
        if (def.maxKeys === undefined && entriesCanFail(def)) found.push(at);
        walk(def.keyType, `${at}{key}`);
        walk(def.valueType, `${at}{}`);
        return;
      case 'ZodSet':
        if (!def.maxSize) found.push(at);
        walk(def.valueType, `${at}[]`);
        return;
      case 'ZodMap':
        found.push(at);
        walk(def.keyType, `${at}{key}`);
        walk(def.valueType, `${at}{}`);
        return;
      case 'ZodTuple':
        (def.items as unknown[]).forEach((item, i) => walk(item, `${at}[${i}]`));
        if (def.rest) {
          found.push(`${at}[...]`);
          walk(def.rest, `${at}[...]`);
        }
        return;
      case 'ZodObject': {
        const shape = (def.shape as () => Record<string, unknown>)();
        for (const [key, child] of Object.entries(shape)) walk(child, `${at}.${key}`);
        if (defOf(def.catchall).typeName !== 'ZodNever') {
          if (!isPassthrough(def.catchall)) found.push(`${at}.*`);
          walk(def.catchall, `${at}.*`);
        }
        return;
      }
      case 'ZodUnion':
      case 'ZodDiscriminatedUnion':
        for (const option of def.options as Iterable<unknown>) walk(option, at);
        return;
      case 'ZodIntersection':
        walk(def.left, at);
        walk(def.right, at);
        return;
      case 'ZodLazy':
        walk((def.getter as () => unknown)(), at);
        return;
      case 'ZodEffects':
        walk(def.schema, at);
        return;
      case 'ZodPipeline':
        walk(def.in, at);
        walk(def.out, at);
        return;
      case 'ZodBranded':
        walk(def.type, at);
        return;
      case 'ZodOptional':
      case 'ZodNullable':
      case 'ZodDefault':
      case 'ZodCatch':
      case 'ZodReadonly':
      case 'ZodPromise':
        walk(def.innerType ?? def.type, at);
        return;
      default:
        return;
    }
  };
  walk(schema, path);
  return found;
}
