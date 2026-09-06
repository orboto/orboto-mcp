/**
 * ORB-1669 - safety-annotation ratchet for the MCP tool surface.
 *
 * MCP clients use `annotations` to decide whether a tool call needs a
 * confirmation step. The hints DEFAULT badly for us: per the MCP spec a
 * tool with no annotations is read-only=false / destructive=true /
 * idempotent=false - so an unannotated read looks dangerous, and (worse,
 * because it is the silent direction) a write annotated only with
 * `{ readOnlyHint: false }` still reports destructive=true. Before this
 * ticket 90 of 168 tools carried nothing at all and `orboto_bulk_close`
 * was indistinguishable from `orboto_get_ticket`.
 *
 * This test enumerates the tools exactly as a client sees them  - 
 * `tools/list` over an in-memory transport, not a source scan - and
 * fails the build on a new tool that skips its annotations. There is no
 * allowlist on purpose: unlike the dark-mode / i18n ratchets there is no
 * legitimate "sanctioned exception", every tool can answer these
 * questions.
 *
 * THE CONVENTION (apply it when you add a tool):
 *
 *   readOnlyHint: true    - performs no writes at all.
 *   destructiveHint: true - the call can DELETE or REMOVE a row, DISCARD
 *                           content, take over state owned by someone
 *                           else, or mutate many tickets at once. If ANY
 *                           argument combination can do that, the tool is
 *                           destructive - the hint is per-tool and cannot
 *                           be conditioned on a flag (this is why
 *                           `orboto_claim` is destructive: `sole=true`
 *                           strips every other assignee).
 *   destructiveHint: false- purely additive, or a reversible single-entity
 *                           field/state update.
 *   idempotentHint: true  - repeating the call with identical arguments
 *                           has no further effect.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildOrbotoMcpServer } from './server.js';

/** Anthropic's connector review caps the human-readable tool title. It is
 *  also just good UI hygiene - a title that long is a description. */
const TITLE_MAX = 64;

interface ListedTool {
  name: string;
  title?: string;
  inputSchema?: { properties?: Record<string, unknown> };
  annotations?: {
    title?: string;
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
}

let tools: ListedTool[];

function unsafeTakeoverTools(list: ListedTool[]): string[] {
  return list
    .filter((tool) => Object.prototype.hasOwnProperty.call(tool.inputSchema?.properties ?? {}, 'takeover'))
    .filter((tool) => tool.annotations?.readOnlyHint !== false || tool.annotations?.destructiveHint !== true)
    .map((tool) => tool.name);
}

beforeAll(async () => {
  // Port 1 is never listened on -> the connect-time /agent-instructions
  // fetch fails immediately and the server falls back to its built-in
  // rules. No network, no fixture server, no timeout.
  // ORB-1520 made the CURATED manifest the default; the annotation contract
  // covers every registered tool, so this ratchet lists the FULL toolset.
  const server = await buildOrbotoMcpServer({ baseUrl: 'http://127.0.0.1:1', apiKey: 'orb_test', toolset: 'full' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'annotation-ratchet', version: '0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  tools = (await client.listTools()).tools as ListedTool[];
  await client.close();
});

describe('MCP tool safety annotations (ORB-1669)', () => {
  it('enumerates the full tool surface', () => {
    // Guards the guard: if the in-memory handshake ever silently returns
    // nothing, every expectation below would vacuously pass.
    expect(tools.length).toBeGreaterThan(150);
  });

  it('every tool declares annotations with an explicit readOnlyHint', () => {
    const offenders = tools
      .filter((t) => typeof t.annotations?.readOnlyHint !== 'boolean')
      .map((t) => t.name);
    expect(
      offenders,
      `Tools missing an explicit \`readOnlyHint\`: ${offenders.join(', ')}.\n` +
      'Add an `annotations` block to the tool config in apps/mcp/src/tools/ - see the convention at the top of this file.',
    ).toEqual([]);
  });

  it('every write tool declares an explicit destructiveHint', () => {
    // The load-bearing one. `{ readOnlyHint: false }` alone leaves
    // destructiveHint defaulting to TRUE, so a harmless write advertises
    // itself as destructive and the signal stops meaning anything.
    const offenders = tools
      .filter((t) => t.annotations?.readOnlyHint === false)
      .filter((t) => typeof t.annotations?.destructiveHint !== 'boolean')
      .map((t) => t.name);
    expect(
      offenders,
      `Write tools missing an explicit \`destructiveHint\`: ${offenders.join(', ')}.\n` +
      'A write with no destructiveHint is reported to clients as destructive (spec default). Set it deliberately, true or false.',
    ).toEqual([]);
  });

  it('read-only tools never claim to be destructive', () => {
    const offenders = tools
      .filter((t) => t.annotations?.readOnlyHint === true && t.annotations?.destructiveHint === true)
      .map((t) => t.name);
    expect(offenders, `Contradictory annotations on: ${offenders.join(', ')}`).toEqual([]);
  });

  it('every takeover-capable tool is a destructive write for all argument combinations', () => {
    const capable = tools.filter((tool) => Object.prototype.hasOwnProperty.call(tool.inputSchema?.properties ?? {}, 'takeover'));
    // Pin the actual siblings so losing schema discovery cannot pass vacuously.
    expect(capable.map((tool) => tool.name)).toEqual(expect.arrayContaining(['orboto_work_start', 'orboto_work_session_start']));
    expect(unsafeTakeoverTools(tools)).toEqual([]);
    // Reservation without a takeover path is not an account-state takeover.
    expect(tools.find((tool) => tool.name === 'orboto_work_next')?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false });
  });

  it('the takeover ratchet catches missing, false and contradictory hints on future tools', () => {
    const future: ListedTool = { name: 'future_takeover', inputSchema: { properties: { takeover: { type: 'boolean' } } } };
    for (const annotations of [undefined, { readOnlyHint: false }, { readOnlyHint: false, destructiveHint: false }, { readOnlyHint: true, destructiveHint: true }]) {
      expect(unsafeTakeoverTools([{ ...future, annotations }])).toEqual(['future_takeover']);
    }
    expect(unsafeTakeoverTools([{ ...future, annotations: { readOnlyHint: false, destructiveHint: true } }])).toEqual([]);
    expect(unsafeTakeoverTools([{ name: 'ordinary_read', annotations: { readOnlyHint: true } }])).toEqual([]);
  });

  it(`every tool has a human-readable title of at most ${TITLE_MAX} characters`, () => {
    const missing = tools.filter((t) => !(t.title ?? t.annotations?.title)).map((t) => t.name);
    expect(missing, `Tools with no title: ${missing.join(', ')}`).toEqual([]);

    const tooLong = tools
      .map((t) => ({ name: t.name, title: (t.title ?? t.annotations?.title) as string }))
      .filter((t) => t.title.length > TITLE_MAX)
      .map((t) => `${t.name} (${t.title.length}: "${t.title}")`);
    expect(
      tooLong,
      `Titles over ${TITLE_MAX} characters: ${tooLong.join('; ')}.\n` +
      'Shorten the `title` - the long form belongs in `description`.',
    ).toEqual([]);
  });
});
