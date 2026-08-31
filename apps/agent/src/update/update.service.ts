import { Logger } from '@dunx/core';
import { AgentConfigService } from '../config/settings.js';
import { PanelClient } from '../panel/panel-client.js';

/** Where `install` puts the binary, and therefore what an update replaces. */
export const INSTALL_PATH = '/usr/local/bin/dunxon-agent';

/**
 * Self-update: ask what is published, verify it, swap it in.
 *
 * The hash check is the point. Without it an update is a blind overwrite of the
 * one binary that manages the host, and the panel is then a single place from
 * which every machine can be replaced.
 *
 * This runs as root from a companion timer rather than from the service, because
 * the service runs unprivileged and cannot write to `/usr/local/bin`.
 */
export class UpdateService {
  constructor(
    private readonly panel: PanelClient,
    private readonly config: AgentConfigService,
    private readonly logger: Logger,
  ) {}

  /** `true` when a newer release was installed. */
  async run(): Promise<boolean> {
    const manifest = await this.panel.manifest();
    const current = this.config.get('version');
    if (manifest.version === current) {
      this.logger.info('already current', { version: current });
      return false;
    }

    const bytes = await this.panel.download();
    const sha256 = new Bun.CryptoHasher('sha256').update(bytes).digest('hex');
    if (sha256 !== manifest.sha256) {
      throw new Error(
        `Refusing to install: sha256 ${sha256.slice(0, 16)} does not match the published ${manifest.sha256.slice(0, 16)}`,
      );
    }

    // Written beside the target and renamed, so a partial download cannot leave
    // an unrunnable binary at the path systemd restarts.
    const staged = `${INSTALL_PATH}.next`;
    await Bun.write(staged, bytes);
    await Bun.$`chmod +x ${staged}`.quiet();
    await Bun.$`mv -f ${staged} ${INSTALL_PATH}`.quiet();
    this.logger.info('updated', { from: current, to: manifest.version });
    return true;
  }
}
