import { Logger } from '@dunx/core';
import { chmodSync, renameSync, unlinkSync } from 'node:fs';
import {
  AgentConfigService,
  SERVICE_NAME,
  UPDATE_SERVICE_NAME,
} from '../config/settings.js';
import { PanelClient } from '../panel/panel-client.js';

/**
 * Self-update: ask what is published, verify it, swap it in.
 *
 * **The hash check is the point.** Without it an update is a blind overwrite of
 * the one binary that manages the host, and the panel becomes a single place
 * from which every machine in the fleet can be replaced with anything.
 *
 * This runs as root from the companion timer rather than from the service,
 * because the service runs unprivileged and cannot write to `/usr/local/bin`.
 */
export class UpdateService {
  constructor(
    private readonly panel: PanelClient,
    private readonly config: AgentConfigService,
    private readonly logger: Logger,
  ) {}

  /**
   * What the running service does when an operator queues `update`.
   *
   * It cannot do the update itself: it runs as an unprivileged user precisely so
   * that it cannot write to `/usr/local/bin`. So it asks the root oneshot unit
   * that exists for this, through the one `sudo` rule `install` grants - a single
   * `systemctl start` on a single unit, which is a far smaller privilege than
   * write access to the binary.
   *
   * `Type=oneshot` is what makes this reportable: `systemctl start` blocks until
   * the update has finished, so the exit status is the outcome.
   */
  async request(): Promise<string> {
    if (process.getuid?.() === 0) {
      // Already root: the CLI path, or a service someone chose to run as root.
      return (await this.run())
        ? 'updated and restarting'
        : 'already on the published version';
    }

    // Production asks the root update unit through the one sudo rule `install`
    // grants. The override runs the swap directly, for a host without systemd -
    // it is exactly what that unit's `ExecStart` does (`dunxon-agent update`), so
    // the operator-driven path is tested rather than left to a real machine.
    const trigger = this.config.get('updateTriggerCommand');
    const command =
      trigger === undefined
        ? ['sudo', '-n', 'systemctl', 'start', UPDATE_SERVICE_NAME]
        : [trigger];
    const result = Bun.spawnSync(command);
    if (!result.success) {
      throw new Error(
        `Cannot update: this agent is unprivileged and could not start ${UPDATE_SERVICE_NAME} (${new TextDecoder().decode(result.stderr).trim() || `exit ${result.exitCode}`}). It will update on its own timer.`,
      );
    }
    return `asked ${UPDATE_SERVICE_NAME} to run`;
  }

  /** `true` when a newer release was installed. Needs root. */
  async run(): Promise<boolean> {
    const manifest = await this.panel.manifest();
    const current = this.config.get('version');
    if (manifest.version === current) {
      this.logger.info('already current', { version: current });
      return false;
    }

    this.logger.info('updating', { from: current, to: manifest.version });
    const bytes = await this.panel.download();
    const sha256 = new Bun.CryptoHasher('sha256').update(bytes).digest('hex');
    if (sha256 !== manifest.sha256) {
      throw new Error(
        `Refusing to install: sha256 ${sha256.slice(0, 16)} does not match the published ${manifest.sha256.slice(0, 16)}`,
      );
    }

    /**
     * Staged beside the target and renamed, because `rename(2)` within one
     * filesystem is atomic: there is no instant at which `INSTALL_PATH` is a
     * half-written file. Writing in place would mean a dropped connection
     * leaving an unrunnable binary at exactly the path systemd restarts, on a
     * host nobody can now reach to fix it.
     *
     * The running process keeps its own inode, so this is safe to do live.
     */
    const installPath = this.config.get('installPath');
    const staged = `${installPath}.next`;
    try {
      await Bun.write(staged, bytes);
      chmodSync(staged, 0o755);
      renameSync(staged, installPath);
    } catch (error) {
      try {
        unlinkSync(staged);
      } catch {
        // Nothing was staged.
      }
      throw error;
    }

    this.logger.info('updated', { from: current, to: manifest.version });
    // systemd owns the lifecycle, so a clean restart is the one path already
    // known to work - `exec`ing the new binary in place would leave systemd
    // tracking a process it did not start.
    this.#restartService();
    return true;
  }

  #restartService(): void {
    // Production restarts through systemd. The override exists only so a host
    // without it - a CI runner, the e2e suite - can still exercise this path and
    // record that the restart fired, rather than the whole step being untested.
    const override = this.config.get('restartCommand');
    const command =
      override === undefined
        ? ['systemctl', 'restart', SERVICE_NAME]
        : [override];
    const result = Bun.spawnSync(command, {
      stdout: 'inherit',
      stderr: 'inherit',
    });
    if (!result.success) {
      // Not fatal. The binary on disk is already the new one, so the next
      // restart for any reason picks it up; saying so beats failing an update
      // that in every other respect succeeded.
      this.logger.warn(
        `installed, but could not restart ${SERVICE_NAME} - it will come up on the next restart`,
      );
    }
  }
}
