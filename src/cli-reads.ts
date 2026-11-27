/**
 * ORB-3289 - the CLI commands that return what a read tool returns, named in the cut notice of the response budget and in the
 * instructions of the tooled toolsets. `command` is the key in docs/cli-surface-inventory.json (cli-reads.test.ts holds every entry to it).
 * A usage names the flat command every installed CLI version knows (ORB-2570), never the noun-first form.
 */
export interface CliPart {
  command: string;
  /** The flat name the usage starts with, when it is not `command`: a legacy alias of it in both CLIs. */
  flat?: string;
  usage: string;
  returns: string;
  /** The tool whose row in the inventory lists this command, when it is not the tool of the entry. */
  tool?: string;
}

export interface CliRead {
  /** One entry when a single command returns what the tool returns; several when the CLI reads the answer in parts. */
  parts: CliPart[];
  /** What the command does not carry over from the tool: paging, filters, flags the CLI lacks. */
  note?: string;
  /** The CLI cannot return the cut answer, it asks again. */
  again?: true;
}

export const CLI_READS: Record<string, CliRead> = {
  orboto_list_tickets: {
    parts: [{ command: 'ticket list', flat: 'list-tickets', usage: 'orboto list-tickets <KEY> --json --all --status all', returns: 'tickets' }],
    note: '`--all` lifts the 50-row cap; `--status all` lists every status like the tool (without it the CLI lists open tickets, `--status <category>` is `statusCategory`); `--all` and `--status all` also list the tickets of completed or archived milestones, which the tool leaves out unless `includeClosedMilestones` is set (`--include-closed-milestones` is that input); `--milestone`, `--unscheduled`, `--parent` and `--sort` take the tool\'s inputs; `specState` and `assigneeEmail` have no flag, filter the JSON',
  },
  orboto_my_tickets: {
    parts: [{ command: 'ticket mine', flat: 'my-tickets', usage: 'orboto my-tickets --json --all', returns: 'tickets' }],
    note: '`--all` lifts the 50-row cap; without `--status` it lists the tool\'s open set, `--status <category>` is `statusCategory`',
  },
  orboto_get_ticket: {
    parts: [
      { command: 'ticket get', flat: 'ticket', usage: 'orboto ticket <KEY> --json', returns: 'ticket row' },
      { command: 'ticket comments', flat: 'comments', usage: 'orboto comments <KEY> --all --json', returns: 'comments' },
      { command: 'get', usage: 'orboto get /tickets/<ticketId>/attachments', returns: 'attachments' },
      { command: 'ticket list', flat: 'list-tickets', usage: 'orboto list-tickets <PROJECT> --parent <KEY> --status all --all --json', returns: 'children', tool: 'orboto_list_tickets' },
      { command: 'get', usage: 'orboto get /tickets/<ticketId>/checklists', returns: 'checklists' },
      { command: 'get', usage: 'orboto get /tickets/<id>/git-activity', returns: 'git activity' },
    ],
    note: '`<ticketId>` and `<id>` are the `id` of the ticket row',
  },
  orboto_query: {
    parts: [{ command: 'query', usage: 'orboto query "<oql>" --json --limit 200', returns: 'tickets' }],
    note: 'one page: page on with `--cursor <nextCursor>` from the document; `--syntax jql` for JQL',
  },
  orboto_search: {
    parts: [{ command: 'search', usage: 'orboto search "<words>" --json --limit 50', returns: 'hits' }],
    note: '`more: true` marks a longer list; `--types` and `--project` take the tool\'s inputs',
  },
  orboto_list_projects: {
    parts: [{ command: 'project list', flat: 'list-projects', usage: 'orboto list-projects --limit 200', returns: 'projects' }],
    note: 'it prints JSON without a flag, `more: true` marks a longer list; `--search` and `--query` take the tool\'s inputs',
  },
  orboto_get_project_primer: {
    parts: [{ command: 'primer', usage: 'orboto primer <KEY>', returns: 'primer' }],
  },
  orboto_list_milestones: {
    parts: [{ command: 'milestone list', flat: 'milestones', usage: 'orboto milestones <KEY> --all --json', returns: 'milestones' }],
    note: '`--all` also lists completed and archived milestones, which the tool leaves out',
  },
  orboto_get_doc: {
    parts: [{ command: 'doc get', usage: 'orboto doc get <doc> --content', returns: 'doc' }],
    note: 'it prints the Markdown only, without `--content` the doc as JSON; `--section "A > B"` reads one section',
  },
  orboto_list_docs_in_space: {
    parts: [{ command: 'doc list', usage: 'orboto doc list <space> --json', returns: 'pages' }],
  },
  orboto_knowledge_ask: {
    parts: [{ command: 'knowledge ask', usage: 'orboto knowledge ask "<question>" --json', returns: 'answer' }],
    again: true,
  },
  orboto_knowledge_find: {
    parts: [{ command: 'knowledge find', usage: 'orboto knowledge find "<words>" --strict --json', returns: 'hits' }],
    note: '`--limit` and `--project` take the tool\'s inputs; `--budget` is `tokenBudget` (100 to 4000 tokens, `--limit` is ignored then); `--strict` is the tool\'s default, and `strict: false` is the same command without `--strict`',
  },
  orboto_wiki_ask: {
    parts: [{ command: 'wiki ask', usage: 'orboto wiki ask "<question>" --json', returns: 'answer' }],
    again: true,
  },
};

/** The two commands the instructions of the tooled toolsets name; each is the start of the usage of its tool in the map above, which adds the filters. */
export const CLI_READS_INSTRUCTION_COMMANDS = ['orboto list-tickets <KEY> --json --all', 'orboto query "<oql>" --json --limit 200'] as const;

/** The sentence the tooled toolsets (curated, full) carry in their instructions. */
export const CLI_READS_INSTRUCTION =
  `With a shell, lists, queries and bulk reads go to the CLI, never cut: \`${CLI_READS_INSTRUCTION_COMMANDS[0]}\`, \`${CLI_READS_INSTRUCTION_COMMANDS[1]}\`. `
  + 'Tools: session start, claims, writes.';

export function cliReadFor(toolName: string): CliRead | undefined {
  return Object.hasOwn(CLI_READS, toolName) ? CLI_READS[toolName] : undefined;
}

/** The sentence a cut notice carries for a mapped tool; it claims the whole body only where one command returns it. */
export function cliReadSentence(read: CliRead): string {
  const note = read.note ? ` (${read.note})` : '';
  if (read.again) {
    return `The cut is an MCP-server artefact: the CLI cannot return this answer, \`${read.parts[0].usage}\` asks again and gives a new answer with new AI usage. There is no CLI expand.`;
  }
  if (read.parts.length > 1) {
    const parts = read.parts.map((part) => `${part.returns}: \`${part.usage}\``).join('; ');
    return `The cut is an MCP-server artefact: no single CLI command returns this tool's whole answer, the CLI reads it in parts - ${parts}${note}. There is no CLI expand.`;
  }
  return `The cut is an MCP-server artefact: the REST API and both CLIs return the complete body, in the shell \`${read.parts[0].usage}\`${note}. There is no CLI expand.`;
}
