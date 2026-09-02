import { Logger, type OnInit } from '@dunx/core';
import { HttpError, HttpStatusCode } from '@dunx/http';
import { Interval } from '@dunx/infra/schedule';
import { AppConfigService } from '../config.js';
import type {
  AgentEventReport,
  AgentInventory,
  DiscoveredHost,
  EnrolRequest,
  EnrolResponse,
  HostReport,
  ReportResponse,
} from '@beacon/contract';
import { AgentsRepository, type AgentRow } from './agents.repository.js';
import { AlertsService } from './alerts.service.js';
import { ScheduleService } from './schedule.service.js';
import type {
  AgentEventView,
  AgentMetricPoint,
  AgentView,
  DiscoveryView,
  InventoryView,
} from '@beacon/contract';
import {
  toAgentEventView,
  toAgentView,
  toDiscoveryView,
  toInventoryView,
  toMetricPoint,
} from './agents.views.js';
import { CommandsService } from './commands.service.js';
import {
  hashToken,
  isGrant,
  mintToken,
  tokenMatches,
  verifyGrant,
} from './enrolment.js';
import { ReleasesService } from './releases.service.js';

/** The one `fleet_settings` key this app uses. */
const PROPAGATION_KEY = 'propagation_allowed';

/**
 * The panel's side of the agent protocol: who an agent is, and what it just
 * said.
 *
 * Every method here is entered from an inbound call. There is no outbound
 * direction and no place to add one - a managed host may be behind NAT or on a
 * network the panel has no route into, so the agent arriving is the only event
 * that exists.
 */
export class AgentsService implements OnInit {
  constructor(
    private readonly repo: AgentsRepository,
    private readonly commands: CommandsService,
    private readonly releases: ReleasesService,
    private readonly alerts: AlertsService,
    private readonly schedule: ScheduleService,
    private readonly config: AppConfigService,
    private readonly logger: Logger,
  ) {}

  onInit(): void {
    this.repo.migrate();
    // After the migration, so the table exists: arm the persisted scheduled
    // tasks in the framework's registry. This is the one ordering the schedule
    // service depends on, which is why it is driven from here rather than its own
    // lifecycle hook.
    this.schedule.armPersisted();
    this.logger.info('agents feature ready', { agents: this.repo.count() });
  }

  /**
   * Expiry has to be swept rather than computed on read: a command that nobody
   * looks at still has to stop being deliverable, and the agent that would
   * collect it may not call for hours.
   */
  @Interval(60_000, { name: 'agents.expire-commands' })
  sweep(): number {
    const before = new Date(
      Date.now() - this.config.get('agents').metricsRetentionMs,
    ).toISOString();
    const pruned = this.repo.pruneMetrics(before);
    if (pruned > 0) this.logger.info('pruned old metrics', { pruned });
    // Scheduled tasks fire on their own cron in the framework's registry, not
    // here - the sweep only expires commands, prunes metrics and judges silence.
    // Silence is the one alert condition that is the absence of a report, so it
    // is judged here on the sweep rather than on ingest.
    this.alerts.evaluateSilence();
    return this.commands.expire();
  }

  /**
   * Enrolment: a host presents a credential that permits creating an agent and
   * receives one that identifies it.
   *
   * The token it gets back is shown exactly once. Only its sha256 is stored, so
   * the panel cannot leak a working fleet credential in a database dump, and an
   * agent that loses its token has to enrol again rather than be told what it
   * was.
   */
  enrol(
    body: EnrolRequest,
    presented: string | null,
    sourceIp: string | null,
  ): EnrolResponse {
    this.#authoriseEnrolment(presented, sourceIp);

    const existing = this.repo.findByMachineId(body.machineId);
    const token = mintToken();
    const now = new Date().toISOString();

    // Lineage: whoever swept and found this address is the one that installed
    // here - true for a panel-brokered grant deploy and for autonomous
    // propagation alike, since both arrive from an address some agent discovered.
    // Attributed on any enrolment, not just grants, so the console can see a
    // fleet that spread itself, not only one deployed a host at a time.
    const installedBy =
      sourceIp === null ? null : this.repo.installerFor(sourceIp);

    const row: AgentRow = {
      id: existing?.id ?? crypto.randomUUID(),
      machineId: body.machineId,
      tokenHash: hashToken(token),
      hostname: body.hostname,
      agentVersion: body.agentVersion,
      os: body.os,
      arch: body.arch,
      // Enrolment is contact, so it counts as being seen. `enrolledAt` is
      // preserved on re-enrolment by the repository, not here.
      enrolledAt: existing?.enrolledAt ?? now,
      lastSeenAt: now,
      lastIp: sourceIp,
      uptimeSeconds: existing?.uptimeSeconds ?? 0,
      agentUptimeSeconds: existing?.agentUptimeSeconds ?? 0,
      lastReport: existing?.lastReport ?? null,
      // Preserve on re-enrolment: the original installer is the causal one.
      installedBy: existing?.installedBy ?? installedBy,
    };
    this.repo.enrol(row);

    // A host that was swept before it was managed stops being offered as a
    // deployment target the moment it enrols.
    if (sourceIp !== null) this.repo.linkDiscovery(sourceIp, row.id);

    this.logger.info(
      existing === null ? 'agent enrolled' : 'agent re-enrolled',
      {
        agentId: row.id,
        hostname: row.hostname,
        sourceIp,
      },
    );
    return { agentId: row.id, agentToken: token };
  }

  /**
   * Two credentials are accepted, and they are not interchangeable.
   *
   * The shared enrolment token admits any host, so it is what an operator uses
   * to place an agent by hand. A **grant** admits one address for a few minutes
   * and is what a delegated deployment carries - so the agent doing the
   * installing never holds something that would admit anything else.
   */
  #authoriseEnrolment(presented: string | null, sourceIp: string | null): void {
    const denied = new HttpError(
      HttpStatusCode.UNAUTHORIZED,
      'Invalid enrolment credential',
    );
    if (presented === null || presented === '') throw denied;

    if (isGrant(presented)) {
      const check = verifyGrant(
        this.config.get('auth').secret,
        presented,
        sourceIp,
        Date.now(),
      );
      if (!check.ok) {
        // Logged, never returned: telling a caller *why* its credential failed
        // turns this endpoint into an oracle for probing valid ones.
        this.logger.warn('deployment grant refused', {
          reason: check.reason,
          sourceIp,
        });
        throw denied;
      }
      // Single-use: an atomic INSERT OR IGNORE returns false when the grant hash
      // is already in the table. A leaked grant can only be spent once.
      if (
        !this.repo.markGrantUsed(hashToken(presented), new Date().toISOString())
      ) {
        this.logger.warn('deployment grant replayed', { sourceIp });
        throw denied;
      }
      return;
    }

    const expected = this.config.get('agents').enrolmentToken;
    if (expected === '') {
      this.logger.warn(
        'enrolment attempted while AGENT_ENROLMENT_TOKEN is unset',
      );
      throw new HttpError(
        HttpStatusCode.FORBIDDEN,
        'Enrolment is disabled: the panel has no AGENT_ENROLMENT_TOKEN set',
      );
    }
    if (!tokenMatches(presented, expected)) throw denied;
  }

  /** The whole of agent authentication, by digest rather than by secret. */
  authenticate(presented: string | null): AgentRow | null {
    if (presented === null || presented === '') return null;
    return this.repo.findByTokenHash(hashToken(presented));
  }

  /**
   * A report, and the answer to it.
   *
   * The response is where control actually happens: the agent asked a question,
   * and anything queued for it rides back on the reply. That is the only push
   * channel a panel that cannot dial out has.
   */
  ingest(
    agent: AgentRow,
    report: HostReport,
    sourceIp: string | null,
  ): ReportResponse {
    const at = new Date();
    // Before collecting: a restart delivered on the *previous* call is settled
    // by this report's arrival, and settling it after collection would leave it
    // outstanding for one extra cycle in the console.
    this.commands.completeRestarts(agent.id, report, at);

    this.repo.recordReport(agent.id, {
      hostname: report.hostname,
      agentVersion: report.agentVersion,
      os: report.os,
      arch: report.arch,
      lastSeenAt: at.toISOString(),
      lastIp: sourceIp,
      uptimeSeconds: report.uptimeSeconds,
      agentUptimeSeconds: report.agentUptimeSeconds,
      lastReport: report,
    });

    // A point in the time series, so the console can chart a trend rather than
    // only the latest snapshot. `at` is the host's own timestamp, so the x-axis
    // is when the sample was taken, not when it happened to arrive.
    this.repo.recordMetric({
      id: crypto.randomUUID(),
      agentId: agent.id,
      at: report.collectedAt,
      memBytes: report.agentMemBytes,
      cpuPercent: report.agentCpuPercent,
      load1: report.load1,
    });

    // Judge the threshold rules against this fresh report, and clear any silence
    // alert (a report is proof of life).
    this.alerts.evaluateReport(agent, report);

    return {
      ok: true,
      agentId: agent.id,
      reportIntervalMs: this.config.get('agents').reportIntervalMs,
      commands: this.commands.collect(agent.id, at.toISOString()),
      // The kill switch, delivered on every report so a pause reaches the fleet
      // within one interval rather than on the next agent restart.
      propagationAllowed: this.propagationAllowed(),
    };
  }

  /** The fleet-wide propagation switch, defaulting to the config seed until set. */
  propagationAllowed(): boolean {
    const stored = this.repo.setting(PROPAGATION_KEY);
    return stored === null
      ? this.config.get('agents').propagationAllowedDefault
      : stored === 'true';
  }

  /** Whether free-form command execution is enabled (config, not runtime). */
  allowArbitraryExec(): boolean {
    return this.config.get('agents').allowArbitraryExec;
  }

  /**
   * Arm or pause fleet-wide propagation, live. Stored, so it survives a restart
   * and overrides the config seed from then on. Logged loudly - arming autonomous
   * spread across a fleet is a decision worth a line in the record.
   */
  setPropagationAllowed(allowed: boolean, by: string | null): boolean {
    this.repo.putSetting(
      PROPAGATION_KEY,
      String(allowed),
      new Date().toISOString(),
      by,
    );
    this.logger.warn('fleet propagation switch changed', { allowed, by });
    return allowed;
  }

  /**
   * What a sweep found. Recorded and nothing else: turning one of these into a
   * managed machine takes a human approving a deployment, because the panel
   * cannot tell a colleague's laptop from a kiosk that belongs in the fleet.
   */
  recordDiscoveries(agent: AgentRow, hosts: readonly DiscoveredHost[]): number {
    const now = new Date().toISOString();
    // A sweep sees the agents that are already managed too. Resolving them here
    // keeps them out of the console's "could be deployed to" list.
    const managed = new Map(
      this.repo
        .list()
        .flatMap((row) => (row.lastIp === null ? [] : [[row.lastIp, row.id]])),
    );
    for (const host of hosts) {
      this.repo.recordDiscovery({
        id: `${agent.id}:${host.address}`,
        foundBy: agent.id,
        address: host.address,
        hostname: host.hostname ?? null,
        ports: [...host.ports],
        firstSeenAt: now,
        lastSeenAt: now,
        enrolledAgentId: managed.get(host.address) ?? null,
      });
    }
    this.logger.info('discovery recorded', {
      agentId: agent.id,
      hosts: hosts.length,
    });
    return hosts.length;
  }

  /**
   * Lifecycle events an agent reported. A restart the agent dies executing has
   * no exit event; a clean `systemctl stop` does - so a host with a startup and
   * no matching exit is one that vanished, which is worth being able to see.
   */
  recordEvents(agent: AgentRow, events: readonly AgentEventReport[]): number {
    const receivedAt = new Date().toISOString();
    this.repo.recordEvents(
      events.map((event) => ({
        id: crypto.randomUUID(),
        agentId: agent.id,
        kind: event.kind,
        message: event.message,
        at: event.at,
        receivedAt,
      })),
    );
    this.logger.info('agent events recorded', {
      agentId: agent.id,
      kinds: events.map((event) => event.kind),
    });
    return events.length;
  }

  /** A host's recent comings and goings, for its detail page. */
  events(id: string, limit: number): readonly AgentEventView[] {
    if (this.repo.find(id) === null) {
      throw new HttpError(HttpStatusCode.NOT_FOUND, `No agent ${id}`);
    }
    return this.repo.eventsFor(id, limit).map(toAgentEventView);
  }

  /**
   * A host's latest inventory snapshot, out of band from the report loop. One
   * row per agent - a fresh snapshot replaces the last, since inventory is a
   * current-state fact, not a time series.
   */
  recordInventory(agent: AgentRow, inventory: AgentInventory): void {
    this.repo.recordInventory({
      agentId: agent.id,
      data: inventory,
      receivedAt: new Date().toISOString(),
    });
    this.logger.info('agent inventory recorded', {
      agentId: agent.id,
      cpuCores: inventory.cpuCores,
      disks: inventory.disks.length,
    });
  }

  /** A host's stored inventory, or null if it has never reported one. */
  inventory(id: string): InventoryView | null {
    if (this.repo.find(id) === null) {
      throw new HttpError(HttpStatusCode.NOT_FOUND, `No agent ${id}`);
    }
    const row = this.repo.inventoryFor(id);
    return row === null ? null : toInventoryView(row);
  }

  /** A window of an agent's metric history, oldest first, for the trend charts. */
  metrics(id: string, minutes: number): readonly AgentMetricPoint[] {
    if (this.repo.find(id) === null) {
      throw new HttpError(HttpStatusCode.NOT_FOUND, `No agent ${id}`);
    }
    const since = new Date(Date.now() - minutes * 60_000).toISOString();
    return this.repo.metricsSince(id, since).map(toMetricPoint);
  }

  list(): readonly AgentView[] {
    const ctx = this.#viewContext();
    return this.repo.list().map((row) => toAgentView(row, ctx));
  }

  find(id: string): AgentView {
    const row = this.repo.find(id);
    if (row === null) {
      throw new HttpError(HttpStatusCode.NOT_FOUND, `No agent ${id}`);
    }
    return toAgentView(row, this.#viewContext());
  }

  /** Forgets a host. Its agent will re-enrol if it is still running and able. */
  remove(id: string): void {
    if (!this.repo.remove(id)) {
      throw new HttpError(HttpStatusCode.NOT_FOUND, `No agent ${id}`);
    }
    this.logger.info('agent removed', { agentId: id });
  }

  discoveries(): readonly DiscoveryView[] {
    return this.repo.discoveries().map(toDiscoveryView);
  }

  #viewContext(): {
    offlineAfterMs: number;
    releaseVersion: string | null;
    now: number;
  } {
    return {
      offlineAfterMs: this.config.get('agents').offlineAfterMs,
      releaseVersion: this.releases.manifest()?.version ?? null,
      now: Date.now(),
    };
  }
}
