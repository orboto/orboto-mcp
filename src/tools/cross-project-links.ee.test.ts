// SPDX-License-Identifier: Orboto-Enterprise-1.0
/**
 * ORB-945 - cross-project-link MCP tools.
 *
 *   - list: renders outgoing + incoming with arrow + sync marker, empty-state
 *   - add: POSTs the right body, surfaces sync-on hint
 *   - update: PATCHes statusSyncEnabled
 *   - remove: DELETEs the row, bubbles 403 on forbidden
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OrbotoApiError, OrbotoClient } from '../orboto-client.js';
import {
  makeListCrossProjectLinksHandler,
  makeAddCrossProjectLinkHandler,
  makeUpdateCrossProjectLinkHandler,
  makeRemoveCrossProjectLinkHandler,
} from './cross-project-links.ee.js';

beforeEach(() => { vi.restoreAllMocks(); });
afterEach(() => { vi.restoreAllMocks(); });

const client = new OrbotoClient({ baseUrl: 'https://orboto.example.com', apiKey: 'orb_x' });
const LINK_ID = '11111111-2222-3333-4444-555555555555';

function stubJSON(responses: Array<{ ok?: boolean; status?: number; json?: unknown }>) {
  const calls: Array<{ url: string; method: string; body?: unknown }> = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    calls.push({
      url: url.toString(),
      method: init?.method ?? 'GET',
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body,
    });
    const r = responses.shift();
    if (!r) throw new Error('unexpected extra fetch');
    return {
      ok: r.ok ?? true,
      status: r.status ?? 200,
      statusText: 'OK',
      json: async () => ('json' in r ? r.json : {}),
      text: async () => '',
    } as unknown as Response;
  });
  return calls;
}

const OUTGOING_LINK = {
  direction: 'outgoing' as const,
  link: {
    id: LINK_ID,
    sourceTicketId: 'src-1',
    targetTicketId: 'tgt-1',
    relationType: 'counterpart' as const,
    statusSyncEnabled: true,
    createdBy: 'u1',
    createdAt: '2026-05-20T16:00:00.000Z',
  },
  otherEnd: {
    ticketId: 'tgt-1',
    ticketKey: 'OCP-7',
    title: 'OCP-side counterpart',
    statusName: 'In Progress',
    statusColor: '#3b82f6',
    statusCategory: 'in_progress',
    projectId: 'p-ocp',
    projectKey: 'OCP',
    projectName: 'orboto Control Plane',
  },
};

describe('orboto_list_cross_project_links', () => {
  it('renders outgoing + sync marker + status', async () => {
    stubJSON([{ json: [OUTGOING_LINK] }]);
    const res = await makeListCrossProjectLinksHandler(client)({ ticketKey: 'ORB-42' });
    const text = (res.content[0] as { text: string }).text;
    expect(text).toContain('counterpart');
    expect(text).toContain('(sync)');
    expect(text).toContain('OCP-side counterpart');
    expect(text).toContain('[In Progress]');
    expect(text).toContain('→');
  });

  it('reports the empty-links case', async () => {
    stubJSON([{ json: [] }]);
    const res = await makeListCrossProjectLinksHandler(client)({ ticketKey: 'ORB-42' });
    expect((res.content[0] as { text: string }).text).toContain('No cross-project links');
  });
});

describe('orboto_add_cross_project_link', () => {
  it('POSTs the source path + body', async () => {
    const calls = stubJSON([{
      status: 201,
      json: {
        id: LINK_ID,
        sourceTicketId: 'src-1',
        targetTicketId: 'tgt-1',
        relationType: 'counterpart',
        statusSyncEnabled: true,
        createdBy: 'u1',
        createdAt: '2026-05-20T16:00:00.000Z',
      },
    }]);
    await makeAddCrossProjectLinkHandler(client)({
      sourceTicketKey: 'ORB-42',
      targetTicketKey: 'OCP-7',
      relationType: 'counterpart',
      statusSyncEnabled: true,
    });
    expect(calls[0]).toMatchObject({
      method: 'POST',
      url: 'https://orboto.example.com/tickets/ORB-42/cross-project-links',
      body: { targetTicketKey: 'OCP-7', relationType: 'counterpart', statusSyncEnabled: true },
    });
  });

  it('bubbles up 403 when caller is not a member of both projects', async () => {
    stubJSON([{ ok: false, status: 403, json: { error: 'You must be a member of both projects' } }]);
    await expect(
      makeAddCrossProjectLinkHandler(client)({
        sourceTicketKey: 'ORB-42',
        targetTicketKey: 'OCP-7',
        relationType: 'related',
      }),
    ).rejects.toBeInstanceOf(OrbotoApiError);
  });

  it('bubbles up 409 on duplicate', async () => {
    stubJSON([{ ok: false, status: 409, json: { error: 'This link already exists' } }]);
    await expect(
      makeAddCrossProjectLinkHandler(client)({
        sourceTicketKey: 'ORB-42',
        targetTicketKey: 'OCP-7',
        relationType: 'counterpart',
      }),
    ).rejects.toBeInstanceOf(OrbotoApiError);
  });
});

describe('orboto_update_cross_project_link', () => {
  it('PATCHes statusSyncEnabled on the linkId', async () => {
    const calls = stubJSON([{
      json: {
        id: LINK_ID,
        sourceTicketId: 'src-1',
        targetTicketId: 'tgt-1',
        relationType: 'counterpart',
        statusSyncEnabled: false,
        createdBy: 'u1',
        createdAt: '2026-05-20T16:00:00.000Z',
      },
    }]);
    await makeUpdateCrossProjectLinkHandler(client)({
      sourceTicketKey: 'ORB-42',
      linkId: LINK_ID,
      statusSyncEnabled: false,
    });
    expect(calls[0]).toMatchObject({
      method: 'PATCH',
      url: `https://orboto.example.com/tickets/ORB-42/cross-project-links/${LINK_ID}`,
      body: { statusSyncEnabled: false },
    });
  });
});

describe('orboto_remove_cross_project_link', () => {
  it('DELETEs the linkId', async () => {
    const calls = stubJSON([{ status: 204 }]);
    const res = await makeRemoveCrossProjectLinkHandler(client)({
      sourceTicketKey: 'ORB-42',
      linkId: LINK_ID,
    });
    expect(calls[0]).toMatchObject({
      method: 'DELETE',
      url: `https://orboto.example.com/tickets/ORB-42/cross-project-links/${LINK_ID}`,
    });
    expect(res.structuredContent).toMatchObject({ deleted: true });
  });

  it('bubbles up 403 when caller can\'t access both ends', async () => {
    stubJSON([{ ok: false, status: 403, json: { error: 'Forbidden' } }]);
    await expect(
      makeRemoveCrossProjectLinkHandler(client)({ sourceTicketKey: 'ORB-42', linkId: LINK_ID }),
    ).rejects.toBeInstanceOf(OrbotoApiError);
  });
});
