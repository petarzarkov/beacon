import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  Agent,
  startPanel,
  waitFor,
  type Operator,
  type Panel,
} from './harness/index.js';

/**
 * Propagation visibility: the fleet's install lineage, and which hosts are
 * spreaders.
 *
 * Autonomous propagation installs a neighbour that then enrols with the shared
 * token, not a panel grant - so the panel cannot be told "agent A installed B"
 * by the credential. It infers it instead: whoever swept and found the address a
 * host enrols from is the one that reached it. These prove that inference (which
 * is what makes a self-spread fleet observable) and the spreader flag a host
 * reports about itself.
 */
describe('propagation lineage', () => {
  let panel: Panel;
  let operator: Operator;

  beforeEach(async () => {
    panel = await startPanel({ reportIntervalMs: 1000 });
    operator = await panel.operator();
  });
  afterEach(async () => {
    await panel.close();
  });

  it('attributes a token-enrolled agent to whichever agent discovered its address', async () => {
    // The seed. It enrols before anything is discovered, so it has no installer.
    const seed = await Agent.started(panel, { machineId: 'seed' });
    const panelPort = parseInt(new URL(panel.url).port, 10);

    try {
      // The seed sweeps and finds 127.0.0.1 (the panel answers on its port), so
      // the panel now knows the seed can reach that address.
      await operator.discover(seed.agentId, {
        cidr: '127.0.0.0/29',
        ports: [panelPort],
      });
      await waitFor(async () => {
        const found = (await operator.discovered()).map((h) => h.address);
        return found.includes('127.0.0.1');
      }, '127.0.0.1 to be discovered by the seed');

      // A neighbour enrols with the shared token from that same address - what an
      // agent the seed propagated to would do. No grant, yet the panel attributes
      // it to the seed, because the seed is who found the address.
      const propagated = await Agent.started(panel, {
        machineId: 'propagated',
      });

      await waitFor(async () => {
        const view = await operator.agent(propagated.agentId);
        return view.installedBy === seed.agentId;
      }, 'the propagated agent to be attributed to the seed');

      // The seed itself is a root - nobody installed it.
      const seedView = await operator.agent(seed.agentId);
      expect(seedView.installedBy).toBeNull();

      await propagated.dispose();
    } finally {
      await seed.dispose();
    }
  });

  it('reports which agents are spreaders (locally opted in to propagate)', async () => {
    const plain = await Agent.started(panel, { machineId: 'plain' });
    const spreader = await Agent.started(panel, {
      machineId: 'spreader',
      extraEnv: { AGENT_PROPAGATE: 'true' },
    });
    try {
      await waitFor(async () => {
        const view = await operator.agent(spreader.agentId);
        return view.propagateEnabled === true;
      }, 'the spreader to report itself as opted in');

      const plainView = await operator.agent(plain.agentId);
      expect(plainView.propagateEnabled).toBe(false);
    } finally {
      await plain.dispose();
      await spreader.dispose();
    }
  });
});
