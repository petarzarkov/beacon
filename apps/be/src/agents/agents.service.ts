import { Logger, type OnInit } from '@dunx/core';
import { HttpError, HttpStatusCode } from '@dunx/http';
import { Interval } from '@dunx/infra/schedule';
import { AppConfigService } from '../config.js';
import type {
  DiscoveredHost,
  EnrolRequest,
  EnrolResponse,
  HostReport,
  ReportResponse,
} from '@dunxon/contract';
import { AgentsRepository, type AgentRow } from './agents.repository.js';
import type { AgentView, DiscoveryView } from '@dunxon/contract';
import { toAgentView, toDiscoveryView } from './agents.views.js';
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
    private readonly config: AppConfigService,
    private readonly logger: Logger,
  ) {}

  onInit(): void {
    this.repo.migrate();
    this.logger.info('agents feature ready', { agents: this.repo.count() });
  }

  /**
   * Expiry has to be swept rather than computed on read: a command that nobody
   * looks at still has to stop being deliverable, and the agent that would
   * collect it may not call for hours.
   */
  @Interval(60_000, { name: 'agents.expire-commands' })
  sweep(): number {
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
