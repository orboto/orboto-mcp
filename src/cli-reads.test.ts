/**
 * ORB-3289 - the CLI command a cut notice names for a read tool is a command that exists: every entry of CLI_READS is held to
 * docs/cli-surface-inventory.json, the source-derived list of the native CLI's commands and flags.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CLI_READS, CLI_READS_INSTRUCTION, cliReadFor } from './cli-reads.js';

interface InventoryCommand {
  command: string;
  native: { flags: Array<{ name: string }> } | null;
  mcpTools: string[];
}

const inventory = JSON.parse(readFileSync(new URL('../../../docs/cli-surface-inventory.json', import.meta.url), 'utf8')) as {
  commands: InventoryCommand[];
  mcpTools: string[];
};

describe('CLI_READS against docs/cli-surface-inventory.json', () => {
  it('maps the tools whose results the budget cuts most: tickets, queries, projects, docs and knowledge', () => {
    for (const tool of [
      'orboto_list_tickets', 'orboto_query', 'orboto_list_projects', 'orboto_get_ticket',
      'orboto_get_doc', 'orboto_list_docs_in_space', 'orboto_knowledge_ask', 'orboto_knowledge_find', 'orboto_wiki_ask',
    ]) {
      expect(cliReadFor(tool), tool).toBeDefined();
    }
    expect(CLI_READS.orboto_list_tickets.usage).toBe('orboto ticket list <KEY> --json');
    expect(CLI_READS.orboto_query.usage).toBe('orboto query "<oql>" --json');
  });

  for (const [tool, read] of Object.entries(CLI_READS)) {
    describe(tool, () => {
      const row = inventory.commands.find((candidate) => candidate.command === read.command);

      it('is a tool of the MCP server', () => {
        expect(inventory.mcpTools).toContain(tool);
      });

      it(`names \`${read.command}\`, a native command of the inventory that this tool maps to`, () => {
        expect(row, `${read.command} is not in docs/cli-surface-inventory.json`).toBeDefined();
        expect(row!.native, `${read.command} has no native command`).not.toBeNull();
        expect(row!.mcpTools).toContain(tool);
      });

      it('spells the command the way the inventory does and passes only flags the command declares', () => {
        expect(read.usage.startsWith(`orboto ${read.command}`)).toBe(true);
        const declared = new Set((row?.native?.flags ?? []).map((flag) => flag.name));
        for (const [, flag] of read.usage.matchAll(/--([a-z][a-z-]*)/g)) {
          expect(declared.has(flag!), `${read.usage}: --${flag} is not a flag of \`${read.command}\``).toBe(true);
        }
      });
    });
  }

  it('the instruction sentence of the tooled toolsets quotes the map, not a copy of it', () => {
    expect(CLI_READS_INSTRUCTION).toContain(`\`${CLI_READS.orboto_list_tickets.usage}\``);
    expect(CLI_READS_INSTRUCTION).toContain(`\`${CLI_READS.orboto_query.usage}\``);
  });

  it('an unmapped tool has no entry, and the lookup does not read the prototype', () => {
    expect(cliReadFor('orboto_no_such_tool')).toBeUndefined();
    expect(cliReadFor('constructor')).toBeUndefined();
    expect(cliReadFor('toString')).toBeUndefined();
  });
});
