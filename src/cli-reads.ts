/**
 * ORB-3289 - the CLI commands that return what a read tool returns, named in the cut notice of the response budget and in the
 * instructions of the tooled toolsets. `command` is the key in docs/cli-surface-inventory.json (cli-reads.test.ts holds every entry to it).
 * A usage names the flat command name (ORB-2570), never the noun-first form, and only flags every CLI since v0.227.0 knows, the last
 * release before the noun-first scheme; a newer flag stays in the note, marked with the first CLI version that has it.
 */
export interface CliPart {
  command: string;
  /** The flat name the usage starts with, when it is not `command`: a legacy alias of it in both CLIs. */
  flat?: string;
  usage: string;
  returns: string;
  /** The tool whose row in the inventory lists this command, when it is not the tool of the entry. */
  tool?: string;
  /** The skill wrapper has no such command, so the texts name the Go CLI only. */
  goOnly?: true;
}

export interface CliRead {
  /** One entry when a single command returns what the tool returns; several when the CLI reads the answer in parts. */
  parts: CliPart[];
  /** What the command does not carry over from the tool: paging, filters, flags the CLI lacks. */
  note?: string;
  /** The REST call that prints the complete body in both CLIs since v0.227.0, when the command prints less than the server answer. */
  body?: CliPart;
  /** What the command prints when `body` carries the complete answer. */
  prints?: string;
  /** The CLI cannot return the cut answer, it asks again. */
  again?: true;
}

export const CLI_READS: Record<string, CliRead> = {
  orboto_list_tickets: {
    parts: [{ command: 'ticket list', flat: 'list-tickets', usage: 'orboto list-tickets <KEY> --json --all --status all', returns: 'tickets' }],
    body: { command: 'get', usage: 'orboto get "/projects/<projectId>/tickets?limit=500"', returns: 'page' },
    prints: 'key, title, status, priority, assignees, times per ticket',
    note: 'page: `cursor=<nextCursor>`; params: the tool\'s inputs by name (`open` too), ids `milestoneId` (`orboto milestones <KEY> --all --json`), `parentTicketId` (`orboto ticket <KEY> --json`), `assigneeId` (user in `orboto get /projects/<projectId>/members`) for `milestone`, `parentTicketKey`, `assigneeEmail`; `<projectId>`: `orboto get /projects/by-key/<KEY>`. Command: `--all` lifts the 50-row cap, without `--status all` only open tickets; `--include-closed-milestones` (CLI 0.233.1 and later), there also `--all` and `--status all`, add closed-milestone tickets the tool omits, older CLIs need `includeClosedMilestones=true`; `--status`, `--milestone`, `--unscheduled`, `--parent`, `--sort` are tool inputs',
  },
  orboto_my_tickets: {
    parts: [{ command: 'ticket mine', flat: 'my-tickets', usage: 'orboto my-tickets --json --all', returns: 'tickets' }],
    body: { command: 'get', usage: 'orboto get "/users/me/assigned-tickets?statuses=TODO,IN_PROGRESS,IN_REVIEW&limit=50"', returns: 'page' },
    prints: 'key, title, status, priority, assignees and times per ticket',
    note: 'the REST call pages with `cursor=<nextCursor>`, and `statuses=<STATUS>` is `statusCategory` (TODO, IN_PROGRESS, IN_REVIEW, DONE or WONT_FIX); in the command `--all` lifts the 50-row cap, without `--status` it lists the tool\'s open set, `--status <category>` is `statusCategory`',
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
    parts: [{ command: 'query', usage: 'orboto query "<oql>" --limit 200', returns: 'tickets' }],
    body: { command: 'post', usage: 'orboto post /query \'{"oql":"<oql>","limit":200}\'', returns: 'page' },
    prints: 'one line per ticket',
    note: 'one page, the next with `--cursor <nextCursor>` from its last line in every CLI since v0.227.0; `--json` (CLI 0.241.0 and later) and the global `--json` of the skill wrapper print the complete page, `{ items, nextCursor }`; `--syntax jql` for JQL',
  },
  orboto_search: {
    parts: [{ command: 'search', usage: 'orboto search "<words>" --json --limit 50', returns: 'hits' }],
    body: { command: 'get', usage: 'orboto get "/search?q=<words>&limit=100"', returns: 'page' },
    prints: 'each hit without `spaceName`, and neither `pass` nor `total`',
    note: 'in the REST call `<words>` is URL-encoded, `%20` for a space; page with `cursor=<nextCursor>`; `types` (comma list) and `projectId` for `projectKey` (`id` in `orboto get /projects/by-key/<KEY>`) as query parameters; in the command `more: true` marks a longer list, `--types` and `--project` take the tool\'s inputs',
  },
  orboto_list_projects: {
    parts: [{ command: 'project list', flat: 'list-projects', usage: 'orboto list-projects --limit 200', returns: 'projects' }],
    body: { command: 'get', usage: 'orboto get /projects', returns: 'projects' },
    prints: 'key, name and status per project, as JSON without a flag',
    note: '`search=<words>` (URL-encoded, `%20` for a space) on the REST call is the tool\'s `search`; in the command `more: true` marks a longer list, `--search` and `--query` take the tool\'s inputs',
  },
  orboto_get_project_primer: {
    parts: [{ command: 'primer', usage: 'orboto primer <KEY>', returns: 'primer' }],
  },
  orboto_list_milestones: {
    parts: [{ command: 'milestone list', flat: 'milestones', usage: 'orboto milestones <KEY> --all --json', returns: 'milestones' }],
    note: '`--all` also lists completed and archived milestones, which the tool leaves out',
  },
  orboto_get_doc: {
    parts: [{ command: 'doc get', usage: 'orboto doc get <doc>', returns: 'doc' }],
    note: 'it prints the doc as JSON with the raw body, `--content` the Markdown only; `--section "A > B"` (CLI 0.236.0 and later) reads one section',
  },
  orboto_list_docs_in_space: {
    parts: [{ command: 'doc list', usage: 'orboto doc list <space> --json', returns: 'pages' }],
  },
  orboto_knowledge_ask: {
    parts: [{ command: 'knowledge ask', usage: 'orboto knowledge ask "<question>" --json', returns: 'answer', goOnly: true }],
    again: true,
  },
  orboto_knowledge_find: {
    parts: [{ command: 'knowledge find', usage: 'orboto knowledge find "<words>" --json', returns: 'hits', goOnly: true }],
    note: '`--limit` and `--project` take the tool\'s inputs; `--budget` (CLI 0.238.0 and later) is `tokenBudget` (100 to 4000 tokens, `--limit` is ignored then); the tool\'s default is `strict: true`, which is `--strict` (CLI 0.236.0 and later), and the command without it is `strict: false`',
  },
  orboto_wiki_ask: {
    parts: [{ command: 'wiki ask', usage: 'orboto wiki ask "<question>" --json', returns: 'answer', goOnly: true }],
    again: true,
  },
};

/** The two commands the instructions of the tooled toolsets name; each is the start of the usage of its tool in the map above, which adds the filters. */
export const CLI_READS_INSTRUCTION_COMMANDS = ['orboto list-tickets <KEY> --json --all', 'orboto query "<oql>" --limit 200'] as const;

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
  const goOnly = read.parts[0].goOnly === true;
  if (read.again) {
    return `The cut is an MCP-server artefact: ${goOnly ? 'the Go CLI' : 'the CLI'} cannot return this answer, \`${read.parts[0].usage}\` asks again and gives a new answer with new AI usage. There is no CLI expand.`;
  }
  if (read.body) {
    return `The cut is an MCP-server artefact: the REST API returns the complete body, in either CLI \`${read.body.usage}\`; \`${read.parts[0].usage}\` prints ${read.prints}${note}. There is no CLI expand.`;
  }
  if (read.parts.length > 1) {
    const parts = read.parts.map((part) => `${part.returns}: \`${part.usage}\``).join('; ');
    return `The cut is an MCP-server artefact: no single CLI command returns this tool's whole answer, the CLI reads it in parts - ${parts}${note}. There is no CLI expand.`;
  }
  return `The cut is an MCP-server artefact: the REST API and ${goOnly ? 'the Go CLI' : 'both CLIs'} return the complete body, in the shell \`${read.parts[0].usage}\`${note}. There is no CLI expand.`;
}
