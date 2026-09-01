import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { startPanel, type Panel } from './harness/index.js';

/**
 * The panel as the console's host, not just its API.
 *
 * The operator console is one deploy with the panel: `apps/fe` builds into
 * `apps/be/public`, and the panel serves it. What is asserted here is the wiring
 * that makes that a single origin work - the SPA is served, a deep link resolves
 * to it rather than 404ing, a wrong API path stays a real 404, and the console
 * API is guarded so nothing is readable without signing in.
 */
describe('the console', () => {
  let panel: Panel;
  const built = existsSync(
    join(import.meta.dir, '../apps/be/public/index.html'),
  );

  beforeAll(async () => {
    panel = await startPanel();
  });
  afterAll(async () => {
    await panel.close();
  });

  it('guards the console API until an operator signs in', async () => {
    const response = await fetch(`${panel.url}/api/agents`);
    expect(response.status).toBe(401);
  });

  it('answers a real 404 for an unknown API path, not the SPA', async () => {
    const response = await fetch(`${panel.url}/api/nonsense`, {
      headers: { accept: 'text/html' },
    });
    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain('<div id="root">');
  });

  it('lets a signed-in operator read the fleet', async () => {
    const operator = await panel.operator();
    const agents = await operator.agents();
    expect(Array.isArray(agents)).toBe(true);
  });

  it.skipIf(!built)(
    'serves the console at the root, and for deep links',
    async () => {
      const root = await fetch(`${panel.url}/`, {
        headers: { accept: 'text/html' },
      });
      expect(root.status).toBe(200);
      expect(await root.text()).toContain('<div id="root">');

      // A browser reloaded on a client route gets the app, not a 404 - the SPA
      // fallback rewrites an unmatched navigation to index.html.
      const deep = await fetch(`${panel.url}/agents/some-id`, {
        headers: { accept: 'text/html' },
      });
      expect(deep.status).toBe(200);
      expect(await deep.text()).toContain('<div id="root">');
    },
  );
});
