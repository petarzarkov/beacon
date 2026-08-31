import { Logger } from '@dunx/core';
import { AgentConfigService, CONFIG_PATH } from '../config/settings.js';
import { INSTALL_PATH } from '../update/update.service.js';

export const SERVICE_NAME = 'dunxon-agent';

/**
 * Puts the agent on the host and starts it, idempotently, so re-running it is
 * how an operator upgrades by hand.
 *
 * The service runs as an unprivileged user rather than root, and the update
 * timer runs as root. That split is deliberate: what the agent collects depends
 * on which user it is, so running the reporter as root would silently change the
 * answers, while writing to `/usr/local/bin` needs privilege that the reporter
 * should not hold.
 */
export class InstallService {
  constructor(
    private readonly config: AgentConfigService,
    private readonly logger: Logger,
  ) {}

  async install(_runAs: string): Promise<void> {
    this.config.requirePanel();
    this.logger.error('install is not implemented yet', {
      writes: [
        INSTALL_PATH,
        CONFIG_PATH,
        `/etc/systemd/system/${SERVICE_NAME}.service`,
      ],
      see: 'docs/architecture.md',
    });
    throw new Error('not implemented');
  }

  async uninstall(): Promise<void> {
    this.logger.error('uninstall is not implemented yet', {
      see: 'docs/architecture.md',
    });
    throw new Error('not implemented');
  }
}
