import { Logger } from '@dunx/core';
import { arch, hostname, release } from 'node:os';
import type {
  CommandEnvelope,
  CommandOutcome,
  DeployPayload,
  DiscoverPayload,
} from '@be/agents/agent.contract.js';
import { IdentityStore } from '../config/identity.js';
import { AgentConfigService } from '../config/settings.js';
import { PanelClient } from '../panel/panel-client.js';
import { ProbeService } from '../probe/probe.service.js';
import { DeployService } from '../provision/deploy.service.js';
import { DiscoverService } from '../provision/discover.service.js';
import { PropagateService } from '../provision/propagate.service.js';
import { UpdateService } from '../update/update.service.js';

/** Ceiling on the retry backoff, so a long outage still reconnects promptly. */
const BACKOFF_MAX_MS = 300_000;

/** One line, because that is all the console shows. */
const MAX_DETAIL = 500;

/**
 * `run`: the service mode. Enrol if this host has no identity, then report on
 * the panel's cadence and do whatever comes back.
 *
 * **This loop is the entire control channel.** The panel cannot dial this
 * process - it may be behind NAT, or on a network with no route in - so there is
 * no socket to hold open and nothing to reconnect. A report is a question, and
 * anything queued rides back on the answer. Everything else here is consequence:
 * the cadence is the latency of control, and an agent that cannot reach the panel
 * simply keeps trying rather than entering any kind of degraded state.
 */
export class RunnerService {
  #stopped = false;
  #failures = 0;

  constructor(
    private readonly config: AgentConfigService,
    private readonly panel: PanelClient,
    private readonly probe: ProbeService,
    private readonly identity: IdentityStore,
    private readonly updates: UpdateService,
    private readonly discovery: DiscoverService,
    private readonly deployments: DeployService,
    private readonly propagation: PropagateService,
    private readonly logger: Logger,
  ) {}

  #propagateTimer: ReturnType<typeof setInterval> | null = null;

  /** Resolves only when stopped: `run` is the long-lived mode. */
  async start(): Promise<void> {
    const panelUrl = this.config.requirePanelUrl();
    this.logger.info('starting', {
      panelUrl,
      version: this.config.get('version'),
    });

    for (const signal of ['SIGTERM', 'SIGINT'] as const) {
      process.on(signal, () => {
        this.logger.info(`received ${signal}, stopping`);
        this.#stopped = true;
      });
    }

    await this.#enrol();
    this.#armPropagation();

    let intervalMs = this.config.get('reportIntervalMs');
    while (!this.#stopped) {
      try {
        intervalMs = await this.#tick();
        this.#failures = 0;
      } catch (error) {
        // Never fatal. A panel that is down, a link that is flapping and a DNS
        // failure are all the same thing from here: try again shortly. Exiting
        // would make systemd restart this process to do exactly what the next
        // iteration was going to do anyway.
        this.#failures += 1;
        this.logger.warn('report failed', {
          attempt: this.#failures,
          err: message(error),
        });
      }
      await this.#sleep(this.#backoff(intervalMs));
    }
    if (this.#propagateTimer !== null) clearInterval(this.#propagateTimer);
    this.logger.info('stopped');
  }

  /**
   * On its own timer, not the report loop.
   *
   * A propagation pass sweeps a subnet and can SSH to dozens of hosts, which
   * takes far longer than a report should and must never delay one - an agent
   * that stopped reporting while colonising its segment would look offline to the
   * panel for minutes. Off entirely unless armed. `void` because a failed pass is
   * logged inside and must not become an unhandled rejection.
   */
  #armPropagation(): void {
    if (!this.propagation.enabled) return;
    const intervalMs = this.config.get('propagate').intervalMs;
    this.logger.info('self-propagation armed', { everyMs: intervalMs });
    const pass = (): void => {
      void this.propagation
        .propagate()
        .catch((error: unknown) =>
          this.logger.warn('propagation pass failed', { err: message(error) }),
        );
    };
    // A first pass shortly after start, so a freshly seeded host does not wait a
    // whole interval before it begins spreading.
    this.#propagateTimer = setInterval(pass, intervalMs);
    setTimeout(pass, 2_000);
  }

  /** One report, and whatever it comes back with. Returns the cadence to keep. */
  async #tick(): Promise<number> {
    const response = await this.panel.report(this.probe.collect());

    if (response.commands.length === 0) return response.reportIntervalMs;
    this.logger.info('collected commands', {
      commands: response.commands.map((c) => c.command),
    });

    /**
     * `restart` is held back and run last, after every other outcome has been
     * sent. The process does not survive it, so anything not reported by then
     * is never reported at all - and the panel would be left with a `deploy`
     * sitting `delivered` until its TTL expired, when in fact it had finished.
     */
    const restart = response.commands.find((c) => c.command === 'restart');
    const rest = response.commands.filter((c) => c.command !== 'restart');

    const outcomes: CommandOutcome[] = [];
    for (const command of rest) {
      outcomes.push(await this.#execute(command));
    }
    if (outcomes.length > 0) await this.#reportOutcomes(outcomes);

    if (restart !== undefined) this.#restart();
    return response.reportIntervalMs;
  }

  async #execute(command: CommandEnvelope): Promise<CommandOutcome> {
    this.logger.info('executing', { id: command.id, command: command.command });
    try {
      return { id: command.id, ok: true, detail: await this.#run(command) };
    } catch (error) {
      this.logger.warn('command failed', {
        id: command.id,
        command: command.command,
        err: message(error),
      });
      return {
        id: command.id,
        ok: false,
        detail: message(error).slice(0, MAX_DETAIL),
      };
    }
  }

  async #run(command: CommandEnvelope): Promise<string> {
    switch (command.command) {
      /**
       * Already satisfied by the time it arrives, and that is not a shortcut.
       * A command can only be collected on a report, so the panel received
       * fresh data from this host in the same request that handed this back.
       * Probing again would send a second report milliseconds later saying the
       * same thing.
       */
      case 'report':
        return 'a fresh report was delivered in the same request';

      case 'update':
        return await this.updates.request();

      case 'discover': {
        const hosts = await this.discovery.sweep(
          (command.payload ?? {}) as DiscoverPayload,
        );
        const { recorded } = await this.panel.discovered(hosts);
        return `swept, ${recorded} host(s) answered`;
      }

      case 'deploy': {
        if (command.payload === null)
          throw new Error('deploy job has no payload');
        return await this.deployments.deploy(command.payload as DeployPayload);
      }

      // Handled by the caller, which sends outcomes before the process dies.
      case 'restart':
        return 'restarting';
    }
  }

  /**
   * Sent best effort. Failing to report an outcome must not fail the command
   * that already succeeded - the panel's TTL is what covers a lost outcome, and
   * re-running a deployment to avoid an unacknowledged row would be far worse
   * than a row that expires.
   */
  async #reportOutcomes(outcomes: readonly CommandOutcome[]): Promise<void> {
    try {
      await this.panel.outcomes(outcomes);
    } catch (error) {
      this.logger.warn('could not report outcomes', { err: message(error) });
    }
  }

  /**
   * Exit, and let systemd start us again - `Restart=always` covers a clean exit
   * too. The agent cannot acknowledge this; the panel completes it when a
   * process younger than the delivery reports in. See `commands.service.ts`.
   */
  #restart(): void {
    this.logger.info('restarting on request');
    process.exit(0);
  }

  /**
   * Enrolment, retried forever rather than failed on.
   *
   * A freshly imaged host may well come up before the panel is reachable, and an
   * agent that exited would need someone to notice and start it. Retrying means
   * the fleet assembles itself whenever the network appears.
   */
  async #enrol(): Promise<void> {
    if (this.panel.identity() !== null) {
      this.logger.info('already enrolled', {
        agentId: this.panel.requireIdentity().agentId,
      });
      return;
    }

    let attempt = 0;
    while (!this.#stopped) {
      try {
        await this.panel.enrol({
          hostname: hostname(),
          os: release(),
          arch: arch(),
          agentVersion: this.config.get('version'),
          machineId: this.identity.machineId(),
        });
        return;
      } catch (error) {
        attempt += 1;
        this.logger.warn('enrolment failed', {
          attempt,
          err: message(error),
        });
        await this.#sleep(backoffFor(attempt, 5_000));
      }
    }
  }

  /** Steady cadence while healthy; widening intervals once the panel stops answering. */
  #backoff(intervalMs: number): number {
    return this.#failures === 0
      ? intervalMs
      : Math.min(BACKOFF_MAX_MS, intervalMs * 2 ** Math.min(this.#failures, 6));
  }

  /** Wakes early on a signal, so `systemctl stop` does not wait out an interval. */
  async #sleep(ms: number): Promise<void> {
    const step = 250;
    for (let waited = 0; waited < ms && !this.#stopped; waited += step) {
      await Bun.sleep(Math.min(step, ms - waited));
    }
  }
}

const backoffFor = (attempt: number, baseMs: number): number =>
  Math.min(BACKOFF_MAX_MS, baseMs * 2 ** Math.min(attempt - 1, 6));

const message = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
