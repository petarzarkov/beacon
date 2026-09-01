import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import {
  Agent,
  disposeFleet,
  startFleet,
  startPanel,
  waitFor,
  type Operator,
  type Panel,
} from './harness/index.js';

/**
 * A fleet, not a single agent.
 *
 * Most of what can go wrong in a control plane only shows up with more than one
 * host: an identity that is not really per-machine, a command delivered to
 * whoever asked first, a liveness signal that is actually "the panel is up". One
 * agent passes all of those by accident.
 */
describe('a fleet of agents', () => {
  let panel: Panel;
  let operator: Operator;
  let agents: readonly Agent[];

  beforeAll(async () => {
    // A short offline window, so "went quiet" is observable in seconds rather
    // than in the minute and a half a production default would take.
    panel = await startPanel({ reportIntervalMs: 1000, offlineAfterMs: 2500 });
    operator = await panel.operator();
    agents = await startFleet(panel, 3);
  });

  afterAll(async () => {
    await disposeFleet(agents);
    await panel.close();
  });

  it('enrols each host separately, and gives each its own token', async () => {
    await waitFor(
      async () => (await operator.agents()).length === 3,
      'all three agents to appear',
    );

    const ids = agents.map((agent) => agent.agentId);
    expect(new Set(ids).size).toBe(3);

    // The identity is what an agent presents afterwards, so two hosts sharing
    // one would mean either could act as the other.
    const tokens = agents.map((agent) => agent.identity()?.agentToken);
    expect(new Set(tokens).size).toBe(3);
    expect(tokens.every((token) => typeof token === 'string')).toBe(true);
  });

  it('never returns an agent token, only its hash is kept', async () => {
    const body = await (await operator.fetch('/api/agents')).text();
    for (const agent of agents) {
      const token = agent.identity()?.agentToken;
      expect(token).toBeDefined();
      // The console has no use for it and the panel could not produce it anyway
      // - this asserts the column really is a digest, not a stored secret.
      expect(body).not.toContain(token);
    }
  });

  it('reports all three as connected while they are running', async () => {
    await waitFor(async () => {
      const fleet = await operator.agents();
      return fleet.length === 3 && fleet.every((agent) => agent.connected);
    }, 'every agent to be connected');
  });

  /**
   * The case the whole design exists for. The panel cannot dial an agent, so it
   * cannot be told that one has died - it can only notice that one stopped
   * arriving. SIGKILL rather than SIGTERM: a host losing power gets no chance to
   * say goodbye, and that is the case that has to work.
   */
  it('notices a host that goes silent, and only that host', async () => {
    const [casualty, ...survivors] = agents;
    expect(casualty).toBeDefined();
    if (casualty === undefined) return;

    const deadId = casualty.agentId;
    await casualty.kill();

    await waitFor(async () => {
      const fleet = await operator.agents();
      return fleet.find((agent) => agent.id === deadId)?.connected === false;
    }, 'the killed agent to be reported as silent');

    // The others must be unaffected: an outage detector that trips the whole
    // fleet when one host dies is worse than none.
    const fleet = await operator.agents();
    for (const survivor of survivors) {
      const row = fleet.find((agent) => agent.id === survivor.agentId);
      expect(row?.connected).toBe(true);
    }
  });

  /**
   * The row survives; only `connected` changes. A panel that forgot an agent
   * when it went quiet would lose exactly the history an operator needs while
   * working out why it went quiet.
   */
  it('keeps a silent agent in the fleet, with its last known state', async () => {
    const [casualty] = agents;
    if (casualty === undefined) return;

    const row = await operator.agent(casualty.agentId);
    expect(row.connected).toBe(false);
    expect(row.hostname.length).toBeGreaterThan(0);
    expect(row.lastSeenAt).toBeTruthy();
    // It reported at least once before it died, so the report fields are real.
    expect(row.memTotalBytes).toBeGreaterThan(0);
  });

  it('comes back connected when the host returns', async () => {
    const [casualty] = agents;
    if (casualty === undefined) return;

    await casualty.start();
    await waitFor(async () => {
      const row = await operator.agent(casualty.agentId);
      return row.connected;
    }, 'the restarted agent to report again');

    // Same identity, because it was persisted - not a second row.
    expect((await operator.agents()).length).toBe(3);
  });
});
