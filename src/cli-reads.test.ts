/**
 * ORB-3289 - the CLI commands a cut notice names for a read tool are commands that exist: every part of CLI_READS is held to
 * docs/cli-surface-inventory.json, the source-derived list of the native CLI's commands and flags, and a generic `orboto get <path>` to cli/openapi.json.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CLI_READS, CLI_READS_INSTRUCTION, CLI_READS_INSTRUCTION_COMMANDS, cliReadFor, cliReadSentence } from './cli-reads.js';

interface InventoryCommand {
  command: string;
  native: { flags: Array<{ name: string }> } | null;
  mcpTools: string[];
}

const inventory = JSON.parse(readFileSync(new URL('../../../docs/cli-surface-inventory.json', import.meta.url), 'utf8')) as {
  commands: InventoryCommand[];
  mcpTools: string[];
};
const openapi = JSON.parse(readFileSync(new URL('../../../cli/openapi.json', import.meta.url), 'utf8')) as {
  paths: Record<string, Record<string, unknown>>;
};

const flagsIn = (text: string): string[] => [...text.matchAll(/--([a-z][a-z-]*)/g)].map((match) => match[1]);
const shape = (path: string): string => path.replace(/[<{][^>}]*[>}]/g, '{}');
const declaredFlags = (command: string): Set<string> => new Set((inventory.commands.find((row) => row.command === command)?.native?.flags ?? []).map((flag) => flag.name));

describe('CLI_READS against docs/cli-surface-inventory.json and cli/openapi.json', () => {
  it('maps the tools whose results the budget cuts most: tickets, queries, projects, docs and knowledge', () => {
    for (const tool of [
      'orboto_list_tickets', 'orboto_my_tickets', 'orboto_query', 'orboto_list_projects', 'orboto_get_ticket',
      'orboto_get_doc', 'orboto_list_docs_in_space', 'orboto_knowledge_ask', 'orboto_knowledge_find', 'orboto_wiki_ask',
    ]) {
      expect(cliReadFor(tool), tool).toBeDefined();
    }
  });

  for (const [tool, read] of Object.entries(CLI_READS)) {
    describe(tool, () => {
      it('is a tool of the MCP server', () => {
        expect(inventory.mcpTools).toContain(tool);
      });

      for (const part of read.parts) {
        const row = inventory.commands.find((candidate) => candidate.command === part.command);

        it(`${part.returns}: \`${part.usage}\` starts with the command \`${part.command}\`, a command of the inventory`, () => {
          expect(part.usage.startsWith(`orboto ${part.command}`)).toBe(true);
          expect(row, `${part.command} is not in docs/cli-surface-inventory.json`).toBeDefined();
          expect(row!.native, `${part.command} has no native command`).not.toBeNull();
        });

        if (part.command === 'get') {
          it(`${part.returns}: the API path is a GET route of cli/openapi.json`, () => {
            const path = /^orboto get (\S+)$/.exec(part.usage)?.[1];
            expect(path, part.usage).toBeDefined();
            const routes = Object.entries(openapi.paths).filter(([route]) => shape(route) === shape(path!));
            expect(routes.length, `${path} is no route of cli/openapi.json`).toBeGreaterThan(0);
            expect(routes.some(([, methods]) => 'get' in methods)).toBe(true);
          });
        } else {
          it(`${part.returns}: the command maps back to this tool and passes only flags it declares`, () => {
            expect(row!.mcpTools).toContain(part.tool ?? tool);
            for (const flag of flagsIn(part.usage)) {
              expect(declaredFlags(part.command).has(flag), `${part.usage}: --${flag} is not a flag of \`${part.command}\``).toBe(true);
            }
          });
        }
      }

      it('names only flags of its commands in the note', () => {
        const declared = new Set(read.parts.flatMap((part) => (part.command === 'get' ? [] : [...declaredFlags(part.command)])));
        for (const flag of flagsIn(read.note ?? '')) {
          expect(declared.has(flag), `${tool}: the note names --${flag}, which none of its commands declares`).toBe(true);
        }
      });
    });
  }

  it('orboto_get_ticket names every command for the parts the tool returns and does not claim a whole body', () => {
    const read = CLI_READS.orboto_get_ticket;
    const usages = read.parts.map((part) => part.usage);
    expect(usages).toEqual(expect.arrayContaining([
      'orboto ticket get <KEY> --json',
      'orboto ticket comments <KEY> --all --json',
      'orboto get /tickets/<ticketId>/attachments',
      'orboto get /tickets/<ticketId>/checklists',
      'orboto get /tickets/<id>/git-activity',
    ]));
    expect(usages.some((usage) => /^orboto ticket list \S+ --parent <KEY> --status all --all --json$/.test(usage))).toBe(true);
    const sentence = cliReadSentence(read);
    expect(sentence).toContain('no single CLI command returns this tool\'s whole answer');
    expect(sentence).not.toContain('complete body');
    for (const usage of usages) expect(sentence).toContain(`\`${usage}\``);
  });

  it('a list or a query pages: the cap is lifted or the cursor is named', () => {
    expect(CLI_READS.orboto_query.parts[0].usage).toBe('orboto query "<oql>" --json --limit 200');
    expect(CLI_READS.orboto_query.note).toContain('page on with `--cursor <nextCursor>`');
    expect(CLI_READS.orboto_list_tickets.parts[0].usage).toBe('orboto ticket list <KEY> --json --all --status all');
    expect(CLI_READS.orboto_list_tickets.note).toContain('`--all` lifts the 50-row cap');
    expect(CLI_READS.orboto_list_tickets.note).toContain('`specState` and `assigneeEmail` have no flag');
    expect(CLI_READS.orboto_my_tickets.parts[0].usage).toBe('orboto ticket mine --json --all');
    expect(CLI_READS.orboto_list_projects.parts[0].usage).toBe('orboto project list --limit 200');
  });

  it('closed milestones are named where the CLI lists them and the tool leaves them out', () => {
    expect(CLI_READS.orboto_list_tickets.note).toContain('`--all` and `--status all` also list the tickets of completed or archived milestones');
    expect(CLI_READS.orboto_list_tickets.note).toContain('which the tool leaves out unless `includeClosedMilestones` is set (`--include-closed-milestones` is that input)');
    expect(CLI_READS.orboto_list_milestones.note).toBe('`--all` also lists completed and archived milestones, which the tool leaves out');
  });

  it('knowledge find names --budget as tokenBudget and strict false as the command without --strict', () => {
    const note = CLI_READS.orboto_knowledge_find.note!;
    expect(note).toContain('`--budget` is `tokenBudget` (100 to 4000 tokens, `--limit` is ignored then)');
    expect(note).toContain('`--strict` is the tool\'s default, and `strict: false` is the same command without `--strict`');
  });

  it('a knowledge or wiki answer is asked again, and the sentence says it is a new answer', () => {
    for (const tool of ['orboto_knowledge_ask', 'orboto_wiki_ask']) {
      const sentence = cliReadSentence(CLI_READS[tool]);
      expect(CLI_READS[tool].again, tool).toBe(true);
      expect(sentence, tool).toContain('asks again');
      expect(sentence, tool).toContain('a new answer');
      expect(sentence, tool).not.toContain('complete body');
    }
  });

  it('the instruction sentence of the tooled toolsets quotes commands that start the usage of their tool in the map', () => {
    expect(CLI_READS.orboto_list_tickets.parts[0].usage.startsWith(CLI_READS_INSTRUCTION_COMMANDS[0])).toBe(true);
    expect(CLI_READS.orboto_query.parts[0].usage.startsWith(CLI_READS_INSTRUCTION_COMMANDS[1])).toBe(true);
    for (const command of CLI_READS_INSTRUCTION_COMMANDS) expect(CLI_READS_INSTRUCTION).toContain(`\`${command}\``);
  });

  it('an unmapped tool has no entry, and the lookup does not read the prototype', () => {
    expect(cliReadFor('orboto_no_such_tool')).toBeUndefined();
    expect(cliReadFor('constructor')).toBeUndefined();
    expect(cliReadFor('toString')).toBeUndefined();
  });
});
