import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { createServer, type Server } from 'node:net';
import {
  Agent,
  startPanel,
  waitFor,
  type Operator,
  type Panel,
} from './harness/index.js';

/**
 * Discovery, delegated deployment, and self-propagation - the three parts of
 * getting the agent onto a host that does not have it yet.
 *
 * A real TCP listener on a loopback alias stands in for a neighbour: the agent's
 * sweep is a real connect scan, so a port that actually answers is what it finds.
 * The SSH install itself needs a second real host and cannot run here, so what is
 * asserted for it is the control path around it - a deployment is queued,
 * collected, attempted, and its outcome reported - with the SSH step failing
 * against a host that does not exist, which is itself a faithful outcome.
 */
describe('provisioning', () => {
  let panel: Panel;
  let operator: Operator;
  let agent: Agent;
  const listeners: Server[] = [];

  /** A port that answers a TCP connect, on a loopback alias the sweep will see. */
  const listenOn = (address: string, port: number): Promise<void> =>
    new Promise((resolve, reject) => {
      const server = createServer();
      listeners.push(server);
      server.once('error', reject);
      server.listen(port, address, () => resolve());
    });

  beforeAll(async () => {
    panel = await startPanel({ reportIntervalMs: 1000 });
    operator = await panel.operator();
    agent = await Agent.started(panel);
  });

  afterAll(async () => {
    for (const server of listeners) server.close();
    await agent.dispose();
    await panel.close();
  });

  it('sweeps a subnet and reports the hosts that answer', async () => {
    // Two loopback aliases answer on a spare port; a third address does not.
    const port = 47_311;
    await listenOn('127.0.0.2', port);
    await listenOn('127.0.0.3', port);

    await operator.discover(agent.agentId, {
      cidr: '127.0.0.0/29',
      ports: [port],
    });

    await waitFor(async () => {
      const found = (await operator.discovered()).map((h) => h.address);
      return found.includes('127.0.0.2') && found.includes('127.0.0.3');
    }, 'the two listeners to be discovered');

    const found = (await operator.discovered()).map((h) => h.address);
    // The address with nothing listening is not reported.
    expect(found).not.toContain('127.0.0.4');
  });

  it('refuses a deployment to an address no agent has swept', async () => {
    const response = await operator.fetch('/api/agents/deployments', {
      method: 'POST',
      body: JSON.stringify({
        target: '203.0.113.9',
        credential: { kind: 'password', username: 'root', value: 'pw' },
        panelUrl: panel.url,
      }),
    });
    // Nothing has reported seeing it, so the panel cannot pick an installer.
    expect(response.status).toBe(409);
  });

  /**
   * The full brokered-deploy control path. The target is a loopback alias that
   * answers a TCP connect but is not a real SSH host, so the install fails - and
   * that failure, reported back and shown in the console, is exactly what proves
   * the pipe end to end: queued, delivered, attempted, settled.
   */
  it('carries a deployment through to a reported outcome', async () => {
    const port = 47_312;
    await listenOn('127.0.0.5', port);
    await operator.discover(agent.agentId, {
      cidr: '127.0.0.0/29',
      ports: [port],
    });
    await waitFor(async () => {
      const found = (await operator.discovered()).map((h) => h.address);
      return found.includes('127.0.0.5');
    }, '127.0.0.5 to be discovered');

    const queued = await operator.deploy({
      target: '127.0.0.5',
      credential: { kind: 'password', username: 'nobody', value: 'pw', port },
      panelUrl: panel.url,
      ttlMinutes: 5,
    });
    expect(queued.command).toBe('deploy');
    expect(queued.state).toBe('queued');

    await waitFor(
      async () => {
        const command = (
          await operator.commandsFor(agent.agentId, 'recent')
        ).find((c) => c.id === queued.id);
        // It cannot complete - 127.0.0.5 is not an SSH server - so `failed` is the
        // faithful terminal state, and reaching it proves the whole path ran.
        return command?.state === 'failed';
      },
      'the deployment to be attempted and reported failed',
      40_000,
    );

    const settled = (await operator.commandsFor(agent.agentId, 'recent')).find(
      (c) => c.id === queued.id,
    );
    expect(settled?.detail).toBeTruthy();
  });

  it('plans a self-propagation pass, finding a reachable neighbour', async () => {
    // `propagate --dry-run` is the agent's own sweep-and-filter, run by hand. A
    // listener on a loopback alias is a reachable neighbour; the agent's own
    // addresses must be filtered out of the plan.
    const port = 47_313;
    await listenOn('127.0.0.6', port);

    const result = await agent.run(
      ['propagate', '--dry-run', '--cidr', '127.0.0.0/29'],
      {
        // The sweep uses the propagation port, so point it at the listener.
        AGENT_PROPAGATE_PORT: String(port),
        // Logs share stdout with the JSON result; quiet them so stdout parses.
        LOG_LEVEL: 'error',
      },
    );
    expect(result.code).toBe(0);

    const plan = JSON.parse(result.stdout) as {
      swept: number;
      candidates: string[];
    };
    expect(plan.candidates).toContain('127.0.0.6');
    // 127.0.0.1 is this host; it is never a propagation target.
    expect(plan.candidates).not.toContain('127.0.0.1');
  });
});

describe('propagation lineage', () => {
  /**
   * The `installedBy` field on an agent view records which agent deployed it.
   * For agents enrolled with the shared token (the normal path), it must be
   * null. The grant-based lineage is exercised here at the API level — the SSH
   * install itself cannot run in e2e, but the credential path and lineage
   * recording are independent of it.
   */
  it('shows null installedBy for agents enrolled with the shared token', async () => {
    const p = await startPanel({ reportIntervalMs: 1000 });
    const op = await p.operator();
    const a = await Agent.started(p);
    try {
      const view = await op.agent(a.agentId);
      expect(view.installedBy).toBeNull();
    } finally {
      await a.dispose();
      await p.close();
    }
  });

  it('records the deploying agent on an agent enrolled via a grant', async () => {
    // Use a dedicated panel so the grant and the agents are self-contained.
    const p = await startPanel({ reportIntervalMs: 1000 });
    const op = await p.operator();
    const agentA = await Agent.started(p);

    // The panel is already reachable at 127.0.0.1:panelPort (0.0.0.0 listen).
    // We sweep 127.0.0.0/29 on that port: the only address that answers is
    // 127.0.0.1, so agentA records it in discovered_hosts with foundBy=agentA.
    // The test-runner's enrolment call ALSO comes from 127.0.0.1, so the grant
    // minted for that address passes the source-IP check — and `installerFor`
    // resolves to agentA.
    const panelPort = parseInt(new URL(p.url).port, 10);

    try {
      await op.discover(agentA.agentId, {
        cidr: '127.0.0.0/29',
        ports: [panelPort],
      });
      await waitFor(async () => {
        const found = (await op.discovered()).map((h) => h.address);
        return found.includes('127.0.0.1');
      }, '127.0.0.1 to be discovered (panel port answers)');

      // Mint the grant for 127.0.0.1: this is both the address agentA found
      // and the source IP the test connection presents to the panel.
      const grant = p.grantFor('127.0.0.1');

      // Enrol agent B directly via that grant, simulating what the deploy
      // command would trigger on a real install.
      const { ENROLMENT_HEADER } = await import('@beacon/contract');
      const enrolRes = await fetch(`${p.url}/api/agent/enrol`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          [ENROLMENT_HEADER]: grant,
        },
        body: JSON.stringify({
          hostname: 'deployed-host',
          os: 'linux',
          arch: 'x64',
          agentVersion: '0.0.0',
          machineId: 'grant-lineage-target',
        }),
      });
      expect(enrolRes.ok).toBe(true);
      const { agentId: agentBId } = (await enrolRes.json()) as {
        agentId: string;
      };

      // Agent B's view should name agent A as the installer — because A was
      // the one that found 127.0.0.1 in its sweep.
      const view = await op.agent(agentBId);
      expect(view.installedBy).toBe(agentA.agentId);
    } finally {
      await agentA.dispose();
      await p.close();
    }
  });
});
