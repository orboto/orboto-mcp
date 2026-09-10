/**
 * ORB-1669 - safety-annotation ratchet for the MCP tool surface.
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
  const server = await buildOrbotoMcpServer({ baseUrl: 'http://127.0.0.1:1', apiKey: 'orb_test', toolset: 'full' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'annotation-ratchet', version: '0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  tools = (await client.listTools()).tools as ListedTool[];
  await client.close();
});

describe('MCP tool safety annotations (ORB-1669)', () => {
  it('enumerates the full tool surface', () => {
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
    expect(capable.map((tool) => tool.name)).toEqual(expect.arrayContaining(['orboto_work_start', 'orboto_work_session_start']));
    expect(unsafeTakeoverTools(tools)).toEqual([]);
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
