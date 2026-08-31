import { Logger } from '@dunx/core';
import { PanelClient } from '../panel/panel-client.js';

/**
 * Getting the agent onto a host that does not have it yet.
 *
 * The hard part is not copying a file, it is that installing software on a host
 * needs a remote execution primitive, and whatever holds that credential becomes
 * worth stealing. `landbased-panel` keeps it on the panel and uses SSH once per
 * machine. Putting it on every agent instead would mean every managed host can
 * install software on every other one.
 *
 * The shape this is written for: the agent never holds a standing credential. It
 * discovers candidates on its subnet and reports them; the panel decides; and if
 * a provisioning job is approved the panel hands the agent a credential scoped to
 * one target and a few minutes. See `docs/architecture.md`.
 */
export class ProvisionService {
  constructor(
    private readonly panel: PanelClient,
    private readonly logger: Logger,
  ) {}

  /** Hosts on this agent's subnet that answer, for the panel to decide about. */
  async discover(): Promise<readonly string[]> {
    this.logger.error('discover is not implemented yet', {
      see: 'docs/architecture.md',
    });
    throw new Error('not implemented');
  }
}
