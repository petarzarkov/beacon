import { Logger } from '@dunx/core';
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  AgentConfigService,
  CONFIG_PATH,
  DEFAULT_RUN_USER,
  INSTALL_PATH,
  SERVICE_NAME,
  UNIT_PATH,
  UPDATE_SERVICE_NAME,
  UPDATE_SERVICE_PATH,
  UPDATE_TIMER_NAME,
  UPDATE_TIMER_PATH,
} from '../config/settings.js';

/** Where the identity issued at enrolment lives. Must be writable by the service. */
const STATE_DIR = `/var/lib/${SERVICE_NAME}`;

const MANAGED = `# Managed by \`${SERVICE_NAME} install\` - edits will be overwritten.`;

/**
 * Puts the agent on the host and starts it, idempotently, so re-running it is
 * how an operator upgrades by hand.
 *
 * **The service runs unprivileged and the update timer runs as root.** That
 * split is the reason there are two units rather than one. What the agent
 * collects depends on which user it is, so running the reporter as root would
 * silently change the answers; but writing to `/usr/local/bin` needs privilege
 * the reporter should not hold. Giving the long-running process the smaller half
 * and the once-every-six-hours process the larger one is the trade that follows.
 */
export class InstallService {
  constructor(
    private readonly config: AgentConfigService,
    private readonly logger: Logger,
  ) {}

  async install(runAs: string = DEFAULT_RUN_USER): Promise<void> {
    this.#requireRoot('install');
    // Read before anything is written: an install that gets halfway and then
    // discovers it has no panel URL has already replaced the binary.
    const panelUrl = this.config.requirePanelUrl();
    const token = this.config.requireEnrolmentToken();

    this.#ensureUser(runAs);

    // `Bun.write` creates missing parents, so there is no mkdir dance. The
    // guard is for `install` run from the installed path itself, where source
    // and destination are one file.
    const self = process.execPath;
    if (self !== INSTALL_PATH) {
      this.logger.info(`installing binary -> ${INSTALL_PATH}`);
      await Bun.write(INSTALL_PATH, Bun.file(self));
    }
    chmodSync(INSTALL_PATH, 0o755);

    await Bun.write(
      CONFIG_PATH,
      `${MANAGED}\nPANEL_URL=${panelUrl}\nAGENT_TOKEN=${token}\n`,
    );
    // The enrolment token is a fleet-wide secret, so never world-readable. The
    // service does not run as root, so ownership has to move to the run user or
    // the agent gets EACCES reading its own config and crash-loops.
    this.#own(runAs, CONFIG_PATH, dirname(CONFIG_PATH));
    chmodSync(CONFIG_PATH, 0o600);
    this.logger.info(`wrote ${CONFIG_PATH}`, { owner: runAs, mode: '0600' });

    // The identity the panel issues at enrolment is written here by the service
    // itself, so this has to exist and be owned before the unit starts.
    mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
    this.#own(runAs, STATE_DIR);

    await this.#grantUpdateTrigger(runAs);

    await Bun.write(UNIT_PATH, this.#unit(runAs));
    await Bun.write(UPDATE_SERVICE_PATH, this.#updateService());
    await Bun.write(UPDATE_TIMER_PATH, this.#updateTimer());

    this.#systemctl('daemon-reload');
    this.#systemctl('enable', SERVICE_NAME);
    this.#systemctl('restart', SERVICE_NAME);
    this.#systemctl('enable', '--now', UPDATE_TIMER_NAME);
    this.logger.info(`${SERVICE_NAME} installed and started`, {
      user: runAs,
      updates: UPDATE_TIMER_NAME,
    });
  }

  uninstall(): void {
    this.#requireRoot('uninstall');
    // Best effort throughout: a partially installed agent has to uninstall
    // cleanly, or a failed install is unrecoverable without a manual cleanup.
    for (const args of [
      ['disable', '--now', UPDATE_TIMER_NAME],
      ['disable', SERVICE_NAME],
      ['stop', SERVICE_NAME],
    ]) {
      try {
        this.#systemctl(...args);
      } catch {
        // Already gone.
      }
    }
    Bun.spawnSync([
      'rm',
      '-f',
      UNIT_PATH,
      UPDATE_SERVICE_PATH,
      UPDATE_TIMER_PATH,
      INSTALL_PATH,
      `/etc/sudoers.d/${SERVICE_NAME}`,
    ]);
    this.#systemctl('daemon-reload');
    // The config and the identity are deliberately left. Uninstalling is often
    // a step in reinstalling, and deleting the identity would make the host
    // enrol as a stranger and lose its command history.
    this.logger.info(`${SERVICE_NAME} removed`, {
      kept: [CONFIG_PATH, STATE_DIR],
    });
  }

  /**
   * The one privilege the unprivileged service is given: starting the root
   * oneshot that updates the binary. Nothing else, and no wildcard.
   *
   * Without it an operator's "update now" cannot work at all - the service
   * cannot write to `/usr/local/bin` by design, so it would have to wait for its
   * six-hourly timer. With it, the service can ask for exactly that one unit to
   * run and can report what happened. `visudo -c` validates the file before it
   * is installed, because a malformed drop-in breaks `sudo` for every user on
   * the host, not just this one.
   */
  async #grantUpdateTrigger(runAs: string): Promise<void> {
    const systemctl = Bun.which('systemctl') ?? '/usr/bin/systemctl';
    const path = `/etc/sudoers.d/${SERVICE_NAME}`;
    const staged = `${path}.next`;
    await Bun.write(
      staged,
      `${MANAGED}\n${runAs} ALL=(root) NOPASSWD: ${systemctl} start ${UPDATE_SERVICE_NAME}\n`,
    );
    chmodSync(staged, 0o440);
    const checked = Bun.spawnSync(['visudo', '-c', '-f', staged]);
    if (!checked.success) {
      Bun.spawnSync(['rm', '-f', staged]);
      this.logger.warn(
        'skipping the sudo rule for updates: the generated drop-in did not validate',
      );
      return;
    }
    Bun.spawnSync(['mv', '-f', staged, path]);
    this.logger.info(`wrote ${path}`, {
      allows: `systemctl start ${UPDATE_SERVICE_NAME}`,
    });
  }

  #unit(runUser: string): string {
    return `${MANAGED}
[Unit]
Description=dunxon agent (reports this host to the panel)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${runUser}
ExecStart=${INSTALL_PATH} run
# A crashed or OOM-killed agent must come back without anyone noticing, or the
# panel silently loses sight of this machine and reports it offline.
Restart=always
RestartSec=5
# Don't let a boot loop hammer the box; systemd gives up only if it is truly broken.
StartLimitIntervalSec=300
StartLimitBurst=10

[Install]
WantedBy=multi-user.target
`;
  }

  #updateService(): string {
    return `${MANAGED}
[Unit]
Description=dunxon agent self-update
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
User=root
ExecStart=${INSTALL_PATH} update
`;
  }

  #updateTimer(): string {
    return `${MANAGED}
[Unit]
Description=Check for a newer dunxon agent release

[Timer]
OnBootSec=5min
OnUnitActiveSec=6h
# Spread the fleet out, so a hundred hosts do not pull 80 MB at the same instant.
RandomizedDelaySec=30min
# Catch up after downtime rather than skipping the window entirely.
Persistent=true

[Install]
WantedBy=timers.target
`;
  }

  /**
   * A system account with no login shell and no home, created only if missing.
   *
   * `landbased-panel` could assume its run user existed, because every kiosk was
   * imaged with it. Nothing here can assume that - an agent may be installed on
   * a host this fleet has never seen - so the installer makes one.
   */
  #ensureUser(runAs: string): void {
    if (Bun.spawnSync(['id', '-u', runAs]).success) return;
    this.logger.info(`creating system user ${runAs}`);
    const created = Bun.spawnSync([
      'useradd',
      '--system',
      '--no-create-home',
      '--shell',
      '/usr/sbin/nologin',
      runAs,
    ]);
    if (!created.success) {
      throw new Error(
        `Could not create the user ${runAs}: ${new TextDecoder().decode(created.stderr).trim()}`,
      );
    }
  }

  #own(user: string, ...paths: readonly string[]): void {
    const result = Bun.spawnSync(['chown', '-R', `${user}:${user}`, ...paths]);
    if (!result.success) {
      throw new Error(
        `Could not give ${user} ownership of ${paths.join(', ')}: ${new TextDecoder().decode(result.stderr).trim()}`,
      );
    }
  }

  #systemctl(...args: readonly string[]): void {
    const result = Bun.spawnSync(['systemctl', ...args], {
      stdout: 'inherit',
      stderr: 'inherit',
    });
    if (!result.success) {
      throw new Error(
        `systemctl ${args.join(' ')} failed (${result.exitCode})`,
      );
    }
  }

  #requireRoot(what: string): void {
    if (process.getuid?.() !== 0) {
      throw new Error(
        `${what} must be run as root (try: sudo ${SERVICE_NAME} ${what} ...)`,
      );
    }
  }
}
