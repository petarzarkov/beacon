import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { existsSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';
import { createOperator } from '@be/auth/create-operator.js';
import { Agent, startPanel, type Panel } from './harness/index.js';

/**
 * The console driven the way an operator drives it: a real browser, the built
 * SPA the panel serves, a real agent reporting in behind it.
 *
 * The focus is the dashboard itself - the fleet table, the react-router shell,
 * and each agent's detail page with its lifecycle activity - not the sign-in,
 * which is Better Auth's own and tested there. Signing in is only the means to
 * reach the console.
 *
 * Skipped, not failed, where it cannot run: the console has to be built into the
 * panel's public dir (`bun run build:fe`) and a Chromium installed
 * (`bunx playwright install chromium`). CI does both; a bare checkout has neither.
 */
const built = existsSync(join(import.meta.dir, '../apps/be/public/index.html'));
let chromiumReady = false;
try {
  chromiumReady = existsSync(chromium.executablePath());
} catch {
  chromiumReady = false;
}
const canDrive = built && chromiumReady;

const OPERATOR = {
  email: 'console-e2e@example.com',
  password: 'console-e2e-password',
  name: 'Console E2E',
};

describe('the console (browser)', () => {
  let panel: Panel;
  let agent: Agent;
  let browser: Browser;

  beforeAll(async () => {
    if (!canDrive) return;
    panel = await startPanel({ release: { version: '9.9.9' } });
    // Created out of band, the way `create:admin` makes one - the console has no
    // sign-up, so the browser can only ever sign in to an account that exists.
    await createOperator(panel.app, OPERATOR);
    // A real agent reporting in, so the fleet table has a live row to act on,
    // and a real startup event for the detail page's activity.
    agent = await Agent.started(panel);
    browser = await chromium.launch({ headless: true });
  });

  afterAll(async () => {
    if (!canDrive) return;
    await browser.close();
    await agent.dispose();
    await panel.close();
  });

  // The browser reaches the in-process panel over the loopback it bound.
  const origin = (): string => panel.url.replace('0.0.0.0', '127.0.0.1');

  /** Sign in and land on the fleet. The means to the dashboard, not the subject. */
  const signIn = async (page: Page): Promise<void> => {
    await page.goto(origin());
    await page.getByLabel('Email').fill(OPERATOR.email);
    await page.getByLabel('Password').fill(OPERATOR.password);
    await page.getByRole('button', { name: 'Sign in' }).click();
    // The redirect lands on /agents, whose page heading is distinct from the nav.
    await page.getByRole('heading', { name: 'Agents' }).waitFor();
  };

  it('shows the live agent, opens its detail page with activity, and acts on it', async () => {
    const page = await browser.newPage();
    try {
      await signIn(page);

      // The shell: the published release in the header, and the live agent row.
      await page.getByText('release 9.9.9').waitFor();
      await page.getByText('connected').waitFor();
      const hostLink = page.getByRole('link', { name: hostname() });
      await hostLink.waitFor();

      // Open the agent's own page from its row.
      await hostLink.click();
      await page.getByRole('heading', { name: hostname() }).waitFor();
      expect(page.url()).toContain(`/agents/${agent.agentId}`);

      // The detail the table cannot show: the agent's own stats (not the host's),
      // its lifecycle activity (a real startup), and its command history.
      await page.getByText('Agent memory', { exact: true }).waitFor();
      await page.getByText('Trends').waitFor();
      await page.getByText('Diagnostics').waitFor();
      await page.getByText('Activity').waitFor();
      await page.getByText('startup').waitFor();
      await page.getByText('Command history').waitFor();

      // A deep link, not just an in-app move: reloading resolves back here.
      await page.reload();
      await page.getByRole('heading', { name: hostname() }).waitFor();
      expect(page.url()).toContain(`/agents/${agent.agentId}`);

      // Queue a command from the detail page: honest feedback, then a real
      // settle in this agent's history.
      await page.getByRole('button', { name: 'Report now' }).click();
      await page
        .getByRole('alert')
        .getByText('report queued')
        .first()
        .waitFor();
      await page.getByText('report completed').waitFor();

      // Back to the fleet via the react-router back link.
      await page.getByRole('link', { name: 'Fleet' }).click();
      await page.getByRole('heading', { name: 'Agents' }).waitFor();
      expect(new URL(page.url()).pathname).toBe('/agents');

      // The lineage view: the fleet as an install tree, the host at its root.
      await page.getByRole('button', { name: 'Lineage' }).click();
      await page.getByRole('heading', { name: 'Lineage' }).waitFor();
      await page.getByRole('link', { name: hostname() }).waitFor();
    } finally {
      await page.close();
    }
  });

  it('deep-links straight to an agent detail page', async () => {
    const page = await browser.newPage();
    try {
      // A fresh context signs in, then goes directly to the agent URL - the case
      // of an operator opening a bookmarked or shared link.
      await signIn(page);
      await page.goto(`${origin()}/agents/${agent.agentId}`);
      await page.getByRole('heading', { name: hostname() }).waitFor();
      await page.getByText('Activity').waitFor();
    } finally {
      await page.close();
    }
  });
});
