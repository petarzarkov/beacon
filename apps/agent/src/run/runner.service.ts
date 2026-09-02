import { Logger } from '@dunx/core';
import { arch, hostname, release } from 'node:os';
import type {
  AgentEventKind,
  CommandEnvelope,
  CommandOutcome,
  DeployPayload,
  DiagnosePayload,
  DiscoverPayload,
} from '@beacon/contract';
import { IdentityStore } from '../config/identity.js';
import { AgentConfigService } from '../config/settings.js';
import { DiagnoseService } from '../diagnose/diagnose.service.js';
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
  /** The signal that asked us to stop, for the exit event's message. */
  #stopSignal: string | null = null;

  constructor(
    private readonly config: AgentConfigService,
    private readonly panel: PanelClient,
    private readonly probe: ProbeService,
    private readonly identity: IdentityStore,
    private readonly updates: UpdateService,
    private readonly discovery: DiscoverService,
    private readonly deployments: DeployService,
    private readonly propagation: PropagateService,
    private readonly diagnostics: DiagnoseService,
    private readonly logger: Logger,
  ) {}

  #propagateTimer: ReturnType<typeof setInterval> | null = null;
  /**
   * The panel's half of the propagation kill switch, learned from the last
   * report. Starts paused, so an agent that has not heard from the panel yet - or
   * one whose panel never arms it - does not spread. Both keys must be true: this
   * and the local `AGENT_PROPAGATE`.
   */
  #panelAllowsPropagation = false;

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
        this.#stopSignal = signal;
        this.#stopped = true;
      });
    }

    await this.#enrol();
    // Once enrolled the panel is reachable, so the startup event lands now rather
    // than waiting a report interval. Best-effort: a lost event is not a failure.
    await this.#reportEvent(
      'startup',
      `agent ${this.config.get('version')} started (pid ${process.pid})`,
    );
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
    // A clean stop is the one exit the agent can announce - it dies executing a
    // `restart` and cannot. So a startup with no matching exit is a host that
    // vanished, which is the distinction worth being able to draw in the console.
    await this.#reportEvent(
      'exit',
      `agent stopping${this.#stopSignal === null ? '' : ` (${this.#stopSignal})`}`,
    );
    this.logger.info('stopped');
  }

  /** Best-effort lifecycle report. A lost event must never fail the process. */
  async #reportEvent(kind: AgentEventKind, detail: string): Promise<void> {
    try {
      await this.panel.events([
        { kind, message: detail, at: new Date().toISOString() },
      ]);
    } catch (error) {
      this.logger.warn('could not report lifecycle event', {
        kind,
        err: message(error),
      });
    }
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
    // The local key. Without it there is no timer at all, so a host that never
    // opted in cannot be made to spread by the panel arming the fleet.
    if (!this.propagation.enabled) return;
    const intervalMs = this.config.get('propagate').intervalMs;
    this.logger.info('self-propagation enabled locally, waiting on the panel', {
      everyMs: intervalMs,
    });
    const pass = (): void => {
      // The panel's key. Checked on every pass, not once at arm time, so pausing
      // it in the console stops the next pass rather than needing a restart.
      if (!this.#panelAllowsPropagation) return;
      void this.propagation
        .propagate()
        .catch((error: unknown) =>
          this.logger.warn('propagation pass failed', { err: message(error) }),
        );
    };
    // A first pass shortly after start, so a freshly seeded host that the panel
    // already permits does not wait a whole interval before it begins.
    this.#propagateTimer = setInterval(pass, intervalMs);
    setTimeout(pass, 2_000);
  }

  /** One report, and whatever it comes back with. Returns the cadence to keep. */
  async #tick(): Promise<number> {
    const response = await this.panel.report(this.probe.collect());

    // Learn the panel's propagation switch on every report - before the no-command
    // early return, since a pause carries no command with it. Log only the change.
    if (response.propagationAllowed !== this.#panelAllowsPropagation) {
      this.#panelAllowsPropagation = response.propagationAllowed;
      if (this.propagation.enabled) {
        this.logger.info('panel propagation switch', {
          allowed: response.propagationAllowed,
        });
      }
    }

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

      case 'diagnose': {
        if (command.payload === null)
          throw new Error('diagnose command has no payload');
        return this.diagnostics.run((command.payload as DiagnosePayload).probe);
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
