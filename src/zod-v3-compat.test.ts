/**
 * ORB-2973 - the MCP server cannot import @orboto/shared-schema, so `zod-v3-compat.ts` and `zod-v3-formats.ts` are byte-identical copies; this pins the copies and the grammar of `isoDateTime()` and `urlString()`
 * against what zod 3.25.76 answered (`packages/shared-schema/fixtures/zod-v3-format-table.json`).
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { zodV3Locale } from './zod-v3-compat.js';
import { isoDateTime, urlString } from './zod-v3-formats.js';

z.config(zodV3Locale());

interface Table {
  datetime: {
    grid: { dates: string[]; separators: string[]; times: string[]; zones: string[]; extras: string[] };
    plain: { accepted: string[] };
    offset: { accepted: string[] };
  };
  url: {
    grid: { lead: string[]; scheme: string[]; host: string[]; path: string[]; trail: string[] };
    candidateCount: number;
    acceptedBitmapBase64: string;
  };
}

const read = (relative: string): string => readFileSync(resolve(process.cwd(), relative), 'utf8');
const table = JSON.parse(read('../../packages/shared-schema/fixtures/zod-v3-format-table.json')) as Table;

describe('the zod 3 compatibility module of the MCP server (ORB-2973)', () => {
  it.each(['zod-v3-compat.ts', 'zod-v3-formats.ts'])('%s is a byte-identical copy of packages/shared-schema/src', (file) => {
    expect(read(`src/${file}`)).toBe(read(`../../packages/shared-schema/src/${file}`));
  });

  it.each([
    ['isoDateTime()', {} as { offset?: boolean }, table.datetime.plain.accepted],
    ['isoDateTime({ offset: true })', { offset: true }, table.datetime.offset.accepted],
  ])('%s accepts exactly what zod 3 accepted of every candidate', (_name, options, acceptedList) => {
    const { dates, separators, times, zones, extras } = table.datetime.grid;
    const candidates = new Set(extras);
    for (const d of dates) for (const s of separators) for (const t of times) for (const zone of zones) candidates.add(`${d}${s}${t}${zone}`);
    const accepted = new Set(acceptedList);
    const schema = isoDateTime(options);
    expect([...candidates].filter((candidate) => schema.safeParse(candidate).success !== accepted.has(candidate))).toEqual([]);
    expect(schema.safeParse('x').error?.issues[0]?.message).toBe('Invalid datetime');
  });

  it('urlString accepts exactly what zod 3 accepted of every candidate and returns the value untouched', () => {
    const { lead, scheme, host, path, trail } = table.url.grid;
    const candidates: string[] = [];
    for (const l of lead) for (const s of scheme) for (const h of host) for (const p of path) for (const t of trail) candidates.push(`${l}${s}${h}${p}${t}`);
    expect(candidates).toHaveLength(table.url.candidateCount);
    const bitmap = Buffer.from(table.url.acceptedBitmapBase64, 'base64');
    const schema = urlString();
    const wrong = candidates.filter((candidate, index) => {
      const result = schema.safeParse(candidate);
      return (bitmap[index >> 3]! & (1 << (index & 7))) !== 0 ? !result.success || result.data !== candidate : result.success;
    });
    expect(wrong).toEqual([]);
    expect(schema.safeParse('not a url').error?.issues[0]?.message).toBe('Invalid url');
  });
});
