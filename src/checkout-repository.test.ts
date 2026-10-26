/** ORB-2684 - the checkout repository a heartbeat names parses remotes the way the CLI and the wrapper do. */
import { describe, expect, it } from 'vitest';
import { checkoutRepository, parseRemote, remoteHost } from './checkout-repository.js';
import { inboxViewLine } from './tools/agent-messages.js';

const REMOTES = [
  'https://github.com/orboto/orboto.git',
  'git@github.com:orboto/orboto.git',
  'ssh://git@10.0.0.5:2222/acme/acme.shop.git',
  'https://dev.azure.com/org/project/_git/repo',
  'https://bitbucket.example.org/scm/team/repo.git',
  'https://gitlab.example.org/group/sub/repo',
  'not a remote',
  '',
];

describe('ORB-2684 - checkout repository', () => {
  it('parses every remote form exactly like the wrapper', async () => {
    const wrapperPath = '../../../skills/orboto/scripts/checkout-project.mjs';
    const wrapper = await import(wrapperPath) as { parseRemote(raw: string): unknown; remoteHost(raw: string): string };
    for (const remote of REMOTES) {
      expect(parseRemote(remote), remote).toEqual(wrapper.parseRemote(remote));
      expect(remoteHost(remote), remote).toBe(wrapper.remoteHost(remote));
    }
  });

  it('names owner, name and the lower-cased host; nothing without a parsable origin', () => {
    expect(checkoutRepository('/x', () => 'ssh://git@Forgejo.Example:2222/SilentFuture/game-repo.git')).toEqual({ owner: 'SilentFuture', name: 'game-repo', host: 'forgejo.example' });
    expect(checkoutRepository('/x', () => '')).toBeNull();
    expect(checkoutRepository('/x', () => 'just-a-name')).toBeNull();
  });

  it('the inbox view line names the checkout projects and the hint, and stays silent for a declared view', () => {
    expect(inboxViewLine({ view: 'checkout', projectKeys: ['MSC'], hint: 'Declare one.' })).toBe('Inbox view: checkout - this session lists mail addressed to it, broadcasts and mail of MSC (its checkout). Declare one.');
    expect(inboxViewLine({ view: 'addressed_only', projectKeys: [], hint: 'Declare one.' })).toBe('Inbox view: addressed_only - this session lists mail addressed to it and broadcasts. Declare one.');
    expect(inboxViewLine({ view: 'declared', projectKeys: ['ORB'], hint: null })).toBeNull();
    expect(inboxViewLine(undefined)).toBeNull();
  });
});
