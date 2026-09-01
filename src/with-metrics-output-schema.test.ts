/**
 * ORB-1738 - declared output schemas ADVERTISE the response budget's
 * `__truncation` marker.
 *
 * Second instance of the ORB-1733 class: the budget injects the marker
 * into structuredContent, the SDK advertises output schemas with
 * additionalProperties:false, and strict clients validate structured
 * content against that - so every over-budget response of a tool with a
 * declared outputSchema was rejected wholesale (orboto_list_projects
 * failed on EVERY call of this 57-project workspace; reported via the
 * agent inbox 2026-08-28).
 */
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { listProjectsToolConfig } from './tools/list-projects.js';
import {
  TruncationBlockSchema, TruncationBlockAdvertisedSchema,
  applyResponseBudget, resetPayloadStore,
} from './response-budget.js';

/** Mirrors the reg() transformation in with-metrics.ts (ORB-1805: the
 *  advertised form is the compact, open one). */
function advertisedOutputShape(shape: Record<string, z.ZodTypeAny>) {
  return { ...shape, __truncation: TruncationBlockAdvertisedSchema.optional() };
}

/** What additionalProperties:false enforces on a strict client: every key
 *  of the payload must be a declared property. */
function strictClientAccepts(shape: Record<string, z.ZodTypeAny>, payload: Record<string, unknown>): boolean {
  return Object.keys(payload).every((k) => k in shape);
}

describe('ORB-1738 - __truncation is part of the advertised output schema', () => {
  it('list_projects: an over-budget payload with the marker passes the strict-client check', () => {
    resetPayloadStore();
    const bigResult = {
      content: [{ type: 'text' as const, text: 'projects' }],
      structuredContent: {
        projects: Array.from({ length: 60 }, (_, i) => ({
          id: `id-${i}`, key: `P${i}`, name: `Project ${i} ${'x'.repeat(120)}`,
          status: 'active', description: 'y'.repeat(120),
        })),
        total: 60,
        totalProjects: 60,
        query: null,
      },
    };
    const { result } = applyResponseBudget('orboto_list_projects', bigResult);
    const sc = result.structuredContent as Record<string, unknown>;
    // The budget DID cut and marked it.
    expect(sc.__truncation).toBeDefined();

    const shape = advertisedOutputShape(listProjectsToolConfig.outputSchema);
    // Before the fix this was false - the marker was undeclared.
    expect(strictClientAccepts(shape, sc)).toBe(true);
    // And the marker itself matches BOTH the exact runtime shape and the
    // compact schema actually advertised on the wire (ORB-1805).
    expect(TruncationBlockSchema.safeParse(sc.__truncation).success).toBe(true);
    expect(TruncationBlockAdvertisedSchema.safeParse(sc.__truncation).success).toBe(true);
  });

  it('ORB-1805 - the advertised marker schema is strictly more permissive than the exact one', () => {
    // Anything the exact shape accepts, the advertised one must accept -
    // otherwise the diet would start rejecting valid payloads.
    const block = {
      handle: 'h1', budgetChars: 4000, originalChars: 9000, omittedChars: 5000,
      omitted: [{ path: 'items', kind: 'array', omittedItems: 12, keptItems: 3 }],
      howToGetTheRest: 'call orboto_response_expand',
    };
    expect(TruncationBlockSchema.safeParse(block).success).toBe(true);
    expect(TruncationBlockAdvertisedSchema.safeParse(block).success).toBe(true);
    // A future field added to the runtime block must not break clients.
    expect(TruncationBlockAdvertisedSchema.safeParse({ ...block, futureField: 1 }).success).toBe(true);
  });

  it('the budget layer adds exactly ONE key - __truncation - and nothing else (class sweep)', () => {
    resetPayloadStore();
    const original = {
      content: [{ type: 'text' as const, text: 'x' }],
      structuredContent: {
        projects: Array.from({ length: 40 }, (_, i) => ({ id: `p-${i}`, key: `K${i}`, name: 'n'.repeat(150), status: 'active', description: 'd'.repeat(150) })),
        total: 40, totalProjects: 40, query: null,
      },
    };
    const before = Object.keys(original.structuredContent);
    const { result } = applyResponseBudget('orboto_list_projects', original);
    const after = Object.keys(result.structuredContent as Record<string, unknown>);
    expect(after.filter((k) => !before.includes(k))).toEqual(['__truncation']);
  });

  it('under-budget responses stay byte-identical (no marker, still schema-clean)', () => {
    resetPayloadStore();
    const small = {
      content: [{ type: 'text' as const, text: 'ok' }],
      structuredContent: { projects: [], total: 0, totalProjects: 0, query: null },
    };
    const { result } = applyResponseBudget('orboto_list_projects', small);
    const sc = result.structuredContent as Record<string, unknown>;
    expect(sc.__truncation).toBeUndefined();
    expect(strictClientAccepts(advertisedOutputShape(listProjectsToolConfig.outputSchema), sc)).toBe(true);
  });
});
