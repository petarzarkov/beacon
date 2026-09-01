import { describe, expect, it } from 'bun:test';
import { AppFactory, Module } from '@dunx/core';
import type { DiscoveredHost } from '@be/agents/agent.contract.js';
import { AgentModule } from '../agent.module.js';
import { DiscoverService } from './discover.service.js';
import type { Installer, InstallTarget } from './installer.js';
import { PropagateService } from './propagate.service.js';

/**
 * The propagation decision logic, without a network.
 *
 * What is worth pinning here is the partitioning: an already-installed host is
 * skipped rather than reinstalled, an unreachable one is recorded as failed
 * rather than aborting the pass, and this host's own addresses are never
 * targets. The SSH itself is the `Installer` seam, substituted with a fake, so
 * these run in milliseconds and assert behaviour rather than the network.
 */

/** Records what it was asked to do, and answers however the test set it up to. */
class FakeInstaller implements Installer {
  readonly installed: string[] = [];
  constructor(
    private readonly present: ReadonlySet<string>,
    private readonly unreachable: ReadonlySet<string> = new Set(),
  ) {}

  async isInstalled(
    target: Pick<InstallTarget, 'address' | 'credential'>,
  ): Promise<boolean> {
    if (this.unreachable.has(target.address)) {
      throw new Error(`connection refused: ${target.address}`);
    }
    return this.present.has(target.address);
  }

  async install(target: InstallTarget): Promise<string> {
    if (this.unreachable.has(target.address)) {
      throw new Error(`connection refused: ${target.address}`);
    }
    this.installed.push(target.address);
    return `installed on ${target.address}`;
  }
}

/** Sweep results the test dictates, so the "subnet" is exactly these hosts. */
const fixedSweep =
  (hosts: readonly DiscoveredHost[], local: readonly string[]) =>
  (service: DiscoverService): void => {
    Object.defineProperty(service, 'sweep', {
      value: async () => hosts,
    });
    Object.defineProperty(service, 'localAddresses', {
      value: () => local,
    });
  };

const host = (address: string): DiscoveredHost => ({ address, ports: [22] });

const build = async (
  env: Record<string, string>,
): Promise<{
  propagation: PropagateService;
  discovery: DiscoverService;
  shutdown: () => Promise<void>;
}> => {
  const source: Record<string, string> = {
    PANEL_URL: 'http://panel.test:3000',
    AGENT_TOKEN: 'enrol-token',
    AGENT_PROPAGATE: 'true',
    AGENT_PROPAGATE_USER: 'ops',
    AGENT_PROPAGATE_PASSWORD: 'pw',
    AGENT_PROPAGATE_PANEL_URL: 'http://panel.test:3000',
  };
  // An empty override removes the key rather than setting an invalid one - the
  // schema rejects an empty credential at boot, which is not what a "no
  // credential" test means to exercise.
  for (const [key, value] of Object.entries(env)) {
    if (value === '') delete source[key];
    else source[key] = value;
  }

  @Module({ imports: [AgentModule.withSource(source), AgentModule] })
  class Root {}

  const app = await AppFactory.create(Root);
  return {
    propagation: app.get(PropagateService),
    discovery: app.get(DiscoverService),
    shutdown: () => app.shutdown(),
  };
};

describe('PropagateService', () => {
  it('installs only where the agent is missing, and never on itself', async () => {
    const { propagation, discovery, shutdown } = await build({});
    try {
      fixedSweep(
        [host('10.0.0.1'), host('10.0.0.2'), host('10.0.0.3')],
        ['10.0.0.1'], // this host
      )(discovery);

      const installer = new FakeInstaller(new Set(['10.0.0.2']));
      const result = await propagation.propagate(installer);

      // .1 is self (filtered), .2 already has it (skipped), .3 gets it.
      expect(result.candidates).toEqual(['10.0.0.2', '10.0.0.3']);
      expect(result.installed).toEqual(['10.0.0.3']);
      expect(installer.installed).toEqual(['10.0.0.3']);
      expect(result.skipped.map((s) => s.address)).toEqual(['10.0.0.2']);
    } finally {
      await shutdown();
    }
  });

  it('records an unreachable host as failed without aborting the pass', async () => {
    const { propagation, discovery, shutdown } = await build({});
    try {
      fixedSweep(
        [host('10.0.0.2'), host('10.0.0.3'), host('10.0.0.4')],
        ['10.0.0.1'],
      )(discovery);

      // .3 refuses; .2 and .4 must still be installed.
      const installer = new FakeInstaller(new Set(), new Set(['10.0.0.3']));
      const result = await propagation.propagate(installer);

      expect([...result.installed].sort()).toEqual(['10.0.0.2', '10.0.0.4']);
      expect(result.failed).toHaveLength(1);
      expect(result.failed[0]?.address).toBe('10.0.0.3');
      expect(result.failed[0]?.error).toContain('connection refused');
    } finally {
      await shutdown();
    }
  });

  it('refuses to propagate when disabled', async () => {
    const { propagation, shutdown } = await build({ AGENT_PROPAGATE: 'false' });
    try {
      expect(propagation.enabled).toBe(false);
      await expect(
        propagation.propagate(new FakeInstaller(new Set())),
      ).rejects.toThrow(/disabled/);
    } finally {
      await shutdown();
    }
  });

  it('refuses to propagate with no credential configured', async () => {
    const { propagation, discovery, shutdown } = await build({
      AGENT_PROPAGATE_PASSWORD: '',
    });
    try {
      fixedSweep([host('10.0.0.2')], ['10.0.0.1'])(discovery);
      await expect(
        propagation.propagate(new FakeInstaller(new Set())),
      ).rejects.toThrow(/credential/);
    } finally {
      await shutdown();
    }
  });
});
