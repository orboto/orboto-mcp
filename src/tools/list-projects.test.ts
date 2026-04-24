/**
 * ORB-244 Phase A — reference test for `orbit_list_projects` tool
 * mapping. Confirms that the tool handler:
 *   - calls `GET /projects`
 *   - produces both a text block (for the model) and structured content
 *   - trims the REST response to the tool-schema shape
 *
 * Each future read-tool (Phase B) should follow this test shape.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { OrbitClient } from '../orbit-client.js';
import { makeListProjectsHandler } from './list-projects.js';

beforeEach(() => { vi.restoreAllMocks(); });
afterEach(() => { vi.restoreAllMocks(); });

function mockFetch(json: unknown) {
  return vi.spyOn(globalThis, 'fetch').mockResolvedValue({
    ok: true, status: 200, statusText: 'OK',
    json: async () => json,
  } as unknown as Response);
}

describe('tools/list-projects', () => {
  const client = new OrbitClient({ baseUrl: 'https://orbit.example.com', apiKey: 'orb_test' });

  it('emits a human-readable text block + structured content', async () => {
    mockFetch([
      { id: 'p1', key: 'ACME', name: 'Acme', description: 'Customer portal', status: 'active' },
      { id: 'p2', key: 'TOOL', name: 'Internal Tools', description: null, status: 'draft' },
    ]);
    const result = await makeListProjectsHandler(client)();
    expect(result.content[0]).toEqual({
      type: 'text',
      text: '- ACME — Acme (active)\n- TOOL — Internal Tools (draft)',
    });
    expect(result.structuredContent).toEqual({
      projects: [
        { key: 'ACME', name: 'Acme', status: 'active', description: 'Customer portal' },
        { key: 'TOOL', name: 'Internal Tools', status: 'draft', description: null },
      ],
    });
  });

  it('renders an empty-state text block when the API returns no rows', async () => {
    mockFetch([]);
    const result = await makeListProjectsHandler(client)();
    expect(result.content[0]).toEqual({ type: 'text', text: 'No projects visible to this user.' });
    expect(result.structuredContent).toEqual({ projects: [] });
  });
});
