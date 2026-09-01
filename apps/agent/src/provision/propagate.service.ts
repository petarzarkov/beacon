import { Logger } from '@dunx/core';
import { existsSync, readFileSync } from 'node:fs';
import type { DeployCredential, DiscoveredHost } from '@dunxon/contract';
import { AgentConfigService } from '../config/settings.js';
import { PanelClient } from '../panel/panel-client.js';
import { DiscoverService } from './discover.service.js';
import { SshInstaller, type Installer } from './installer.js';

export interface PropagationResult {
  readonly swept: number;
  readonly candidates: readonly string[];
  readonly installed: readonly string[];
  readonly skipped: readonly { address: string; reason: string }[];
  readonly failed: readonly { address: string; error: string }[];
}

/**
 * Self-propagation: the agent sweeps its own subnet and installs itself onto
 * neighbours, with no panel brokering the credential.
 *
 * This is what makes a fleet assemble itself from one seeded host - place an
 * agent by hand, turn this on, and it populates its segment, and each host it
 * reaches does the same for its own. It is also the one path that holds a
 * standing credential, and so the one a stolen agent could turn against its
 * neighbours; it is off unless `AGENT_PROPAGATE` is set, and the panel-brokered
 * `deploy` remains the credential-free default. See `config/settings.ts`.
 *
 * The decision of *what* to skip is made on the target itself: `isInstalled`
 * asks `dunxon-agent version` over SSH, so a host already in the fleet is left
 * alone without the panel having to be consulted. That keeps a propagating agent
 * able to work even against a subnet the panel has never heard of.
 */
export class PropagateService {
  constructor(
    private readonly config: AgentConfigService,
    private readonly panel: PanelClient,
    private readonly discovery: DiscoverService,
    private readonly logger: Logger,
  ) {}

  get enabled(): boolean {
    return this.config.get('propagate').enabled;
  }

  /**
   * What a pass *would* do, without touching a neighbour: sweep, drop this host's
   * own addresses, and return the rest. The dry run, and what the CLI prints - so
   * an operator can see the blast radius before arming propagation.
   */
  async plan(
    cidr?: string,
  ): Promise<{ swept: number; candidates: readonly string[] }> {
    const propagate = this.config.get('propagate');
    const hosts = await this.discovery.sweep({
      ports: [propagate.port],
      ...(cidr === undefined ? {} : { cidr }),
    });
    const mine = new Set(this.discovery.localAddresses());
    const candidates = hosts
      .map((host) => host.address)
      .filter((address) => !mine.has(address));
    return { swept: hosts.length, candidates };
  }

  /**
   * One propagation pass. Sweeps, skips itself and any host already running the
   * agent, installs on the rest, and tells the panel what it found so an operator
   * can watch a fleet spread. Never throws for a single host: one unreachable
   * neighbour must not stop the others.
   */
  async propagate(
    installer: Installer = new SshInstaller(
      () => this.panel.download(),
      this.logger,
    ),
  ): Promise<PropagationResult> {
    if (!this.enabled) {
      throw new Error('propagation is disabled (set AGENT_PROPAGATE=true)');
    }
    const credential = this.#credential();
    const propagate = this.config.get('propagate');
    // The URL a neighbour dials back on: its own, unless one was set for it. A
    // host cannot know which of the panel's addresses a different host can reach.
    const panelUrl =
      propagate.panelUrl ?? this.panel.requireIdentity().panelUrl;
    const enrolmentToken = this.config.requireEnrolmentToken();

    const hosts = await this.discovery.sweep({ ports: [propagate.port] });
    // Report what was seen regardless of what gets installed: the panel's
    // discovered-hosts view is useful even for a segment nothing installs on.
    await this.#report(hosts);

    const mine = new Set(this.discovery.localAddresses());
    const candidates = hosts
      .map((host) => host.address)
      .filter((address) => !mine.has(address));

    const installed: string[] = [];
    const skipped: { address: string; reason: string }[] = [];
    const failed: { address: string; error: string }[] = [];

    for (const address of candidates) {
      const target = { address, credential };
      try {
        if (await installer.isInstalled(target)) {
          skipped.push({ address, reason: 'already running the agent' });
          continue;
        }
        await installer.install({ ...target, panelUrl, enrolmentToken });
        installed.push(address);
      } catch (error) {
        failed.push({ address, error: message(error) });
      }
    }

    const result: PropagationResult = {
      swept: hosts.length,
      candidates,
      installed,
      skipped,
      failed,
    };
    this.logger.info('propagation pass complete', {
      installed: installed.length,
      skipped: skipped.length,
      failed: failed.length,
    });
    return result;
  }

  /**
   * The credential the fleet shares, assembled from config. A key wins over a
   * password when both are set; the value is the file's contents when
   * `AGENT_PROPAGATE_KEY` names one, and the inline PEM otherwise.
   */
  #credential(): DeployCredential {
    const propagate = this.config.get('propagate');
    if (propagate.user === undefined) {
      throw new Error('AGENT_PROPAGATE_USER is required to propagate');
    }
    if (propagate.key !== undefined) {
      const value = existsSync(propagate.key)
        ? readFileSync(propagate.key, 'utf8')
        : propagate.key;
      return {
        kind: 'privateKey',
        username: propagate.user,
        value,
        port: propagate.port,
      };
    }
    if (propagate.password !== undefined) {
      return {
        kind: 'password',
        username: propagate.user,
        value: propagate.password,
        port: propagate.port,
      };
    }
    throw new Error(
      'propagation needs a credential: set AGENT_PROPAGATE_KEY or AGENT_PROPAGATE_PASSWORD',
    );
  }

  async #report(hosts: readonly DiscoveredHost[]): Promise<void> {
    if (hosts.length === 0 || this.panel.identity() === null) return;
    try {
      await this.panel.discovered(hosts);
    } catch (error) {
      this.logger.warn('could not report propagation sweep', {
        err: message(error),
      });
    }
  }
}

const message = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
