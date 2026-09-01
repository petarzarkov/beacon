import { Logger } from '@dunx/core';
import type { DeployPayload } from '@be/agents/agent.contract.js';
import { PanelClient } from '../panel/panel-client.js';
import { SshInstaller } from './installer.js';

/**
 * The panel-brokered install: an operator names a target, the panel picks the
 * agent positioned to reach it, and that agent runs this.
 *
 * **The agent holds no standing credential on this path.** Everything needed for
 * one install arrives in the job and leaves with it - an SSH credential the
 * operator supplied at approval time, and an enrolment grant the panel signed
 * for this one address and a few minutes. A stolen agent is therefore not a way
 * into its neighbours, which is the property a standing key on every host would
 * destroy. That property is exactly what the autonomous `propagate` path trades
 * away, deliberately, and why the two are separate.
 *
 * The binary written to the target is this running one: `download()` would ask
 * the panel for a copy of what this process already is, over the network, for no
 * reason.
 */
export class DeployService {
  constructor(
    private readonly panel: PanelClient,
    private readonly logger: Logger,
  ) {}

  async deploy(job: DeployPayload): Promise<string> {
    if (Date.parse(job.expiresAt) <= Date.now()) {
      // The grant inside is already dead, so the install would enrol into
      // nothing. Failing here says why, rather than at the last step.
      throw new Error(
        `Deployment for ${job.target} expired at ${job.expiresAt}; queue a new one`,
      );
    }

    const installer = new SshInstaller(
      () => this.panel.download(),
      this.logger,
    );
    return installer.install({
      address: job.target,
      credential: job.credential,
      panelUrl: job.panelUrl,
      enrolmentToken: job.enrolmentToken,
    });
  }
}
