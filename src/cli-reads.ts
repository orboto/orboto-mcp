/**
 * ORB-3289 - the CLI command that returns the whole body of a read tool, named in the cut notice of the response budget and in the
 * instructions of the tooled toolsets. `command` is the key in docs/cli-surface-inventory.json (cli-reads.test.ts holds the map to it).
 */
export interface CliRead {
  command: string;
  usage: string;
}

export const CLI_READS: Record<string, CliRead> = {
  orboto_list_tickets: { command: 'ticket list', usage: 'orboto ticket list <KEY> --json' },
  orboto_my_tickets: { command: 'ticket mine', usage: 'orboto ticket mine --json' },
  orboto_get_ticket: { command: 'ticket get', usage: 'orboto ticket get <KEY> --json' },
  orboto_query: { command: 'query', usage: 'orboto query "<oql>" --json' },
  orboto_search: { command: 'search', usage: 'orboto search "<words>" --json' },
  orboto_list_projects: { command: 'project list', usage: 'orboto project list --limit 200' },
  orboto_get_project_primer: { command: 'primer', usage: 'orboto primer <KEY>' },
  orboto_list_milestones: { command: 'milestone list', usage: 'orboto milestone list <KEY> --json' },
  orboto_get_doc: { command: 'doc get', usage: 'orboto doc get <doc> --content' },
  orboto_list_docs_in_space: { command: 'doc list', usage: 'orboto doc list <space> --json' },
  orboto_knowledge_ask: { command: 'knowledge ask', usage: 'orboto knowledge ask "<question>" --json' },
  orboto_knowledge_find: { command: 'knowledge find', usage: 'orboto knowledge find "<words>" --json' },
  orboto_wiki_ask: { command: 'wiki ask', usage: 'orboto wiki ask "<question>" --json' },
};

/** The sentence the tooled toolsets (curated, full) carry in their instructions; the two commands come from the map above. */
export const CLI_READS_INSTRUCTION =
  `With a shell, lists, queries and bulk reads: the orboto CLI with --json, never cut: \`${CLI_READS.orboto_list_tickets.usage}\`, \`${CLI_READS.orboto_query.usage}\`. `
  + 'Tools: session start, claims, writes.';

export function cliReadFor(toolName: string): CliRead | undefined {
  return Object.hasOwn(CLI_READS, toolName) ? CLI_READS[toolName] : undefined;
}
