import { Logger } from '@dunx/core';
import { HttpError, HttpStatusCode } from '@dunx/http';
import { z } from 'zod';
import { AppConfigService } from '../config.js';
import type {
  AgentCommandName,
  CommandEnvelope,
  CommandOutcome,
  DeployPayload,
  DiagnosePayload,
  DiagnoseProbe,
  DiscoverPayload,
  HostReport,
} from '@beacon/contract';
import { AgentsRepository, type AgentRow } from './agents.repository.js';
import type { CommandView } from '@beacon/contract';
import type { deployRoute, discoverRoute } from './agents.schemas.js';
import { toCommandView } from './agents.views.js';
import { mintGrant } from './enrolment.js';
import { ReleasesService } from './releases.service.js';

type DeployRequest = z.infer<(typeof deployRoute)['body']>;
type DiscoverRequest = z.infer<(typeof discoverRoute)['body']>;

/**
 * The command lifecycle, which is the whole of "control" here.
 *
 * ```
 * queued -> delivered -> completed | failed
 *       \-> expired
 * ```
 *
 * An operator never restarts an agent; they write down that they would like one
 * restarted, and the agent finds it next time it calls. Everything in this class
 * follows from that, including the parts that look like over-engineering: the
 * TTL exists because an agent dark for a week must not come back to a restart
 * nobody remembers asking for, and `completeRestarts` exists because the one
 * command an agent can be given is the one it can never acknowledge.
 */
export class CommandsService {
  constructor(
    private readonly repo: AgentsRepository,
    private readonly releases: ReleasesService,
    private readonly config: AppConfigService,
    private readonly logger: Logger,
  ) {}

  #ttlMs(): number {
    return this.config.get('agents').commandTtlMs;
  }

  #queue(
    agentId: string,
    command: AgentCommandName,
    issuedBy: string | null,
    payload: DeployPayload | DiscoverPayload | DiagnosePayload | null,
    ttlMs: number = this.#ttlMs(),
  ): CommandView {
    const now = new Date();
    const row = {
      id: crypto.randomUUID(),
      agentId,
      command,
      state: 'queued' as const,
      payload,
      queuedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
      deliveredAt: null,
      settledAt: null,
      detail: null,
      issuedBy,
    };
    this.repo.queue(row);
    this.logger.info('command queued', { agentId, command, id: row.id });
    return toCommandView(row);
  }

  /** `report`, `update` and `restart`: the whole instruction is the name. */
  queue(
    agentId: string,
    command: 'report' | 'update' | 'restart',
    issuedBy: string | null,
  ): CommandView {
    this.#requireAgent(agentId);
    if (command === 'update' && this.releases.manifest() === null) {
      throw new HttpError(
        HttpStatusCode.CONFLICT,
        'Nothing to update to: no agent release has been published',
      );
    }
    return this.#queue(agentId, command, issuedBy, null);
  }

  queueDiscover(
    agentId: string,
    body: DiscoverRequest,
    issuedBy: string | null,
  ): CommandView {
    this.#requireAgent(agentId);
    const payload: DiscoverPayload = {
      ...(body.cidr === undefined ? {} : { cidr: body.cidr }),
      ...(body.ports === undefined ? {} : { ports: body.ports }),
    };
    return this.#queue(agentId, 'discover', issuedBy, payload);
  }

  /** Queue a read-only diagnostic. The output rides back as the command's outcome. */
  queueDiagnose(
    agentId: string,
    probe: DiagnoseProbe,
    issuedBy: string | null,
  ): CommandView {
    this.#requireAgent(agentId);
    const payload: DiagnosePayload = { probe };
    return this.#queue(agentId, 'diagnose', issuedBy, payload);
  }

  /**
   * Install onto a host the panel cannot reach, by asking one that can.
   *
   * The operator names a target, not a route to it: which agent is positioned to
   * do the job is the panel's to work out, and the only evidence it has is which
   * agent reported seeing the address. An address nobody has swept is refused
   * rather than guessed at - picking an agent at random would mean a job that
   * fails after a timeout on a machine with no path to the target.
   */
  queueDeploy(body: DeployRequest, issuedBy: string | null): CommandView {
    const discovery = this.repo.finderOf(body.target);
    if (discovery === null) {
      throw new HttpError(
        HttpStatusCode.CONFLICT,
        `No agent has reported seeing ${body.target}. Run a discovery on the subnet first.`,
      );
    }
    if (discovery.enrolledAgentId !== null) {
      throw new HttpError(
        HttpStatusCode.CONFLICT,
        `${body.target} is already managed by agent ${discovery.enrolledAgentId}`,
      );
    }
    const installer = this.repo.find(discovery.foundBy);
    if (installer === null) {
      throw new HttpError(
        HttpStatusCode.CONFLICT,
        `The agent that found ${body.target} is no longer enrolled`,
      );
    }

    const ttlMs = body.ttlMinutes * 60_000;
    const expiresAt = new Date(Date.now() + ttlMs);
    const payload: DeployPayload = {
      target: body.target,
      credential: body.credential,
      // Scoped to this one address and this one window. The installing agent
      // therefore never carries something that would admit any other host.
      enrolmentToken: mintGrant(
        this.config.get('auth').secret,
        body.target,
        expiresAt.getTime(),
      ),
      panelUrl: body.panelUrl,
      expiresAt: expiresAt.toISOString(),
    };
    this.logger.info('deployment queued', {
      target: body.target,
      via: installer.hostname,
    });
    // The command's TTL is the credential's: a job collected after the grant has
    // expired can only fail, so it should not be delivered at all.
    return this.#queue(installer.id, 'deploy', issuedBy, payload, ttlMs);
  }

  /**
   * Hand over everything queued, and mark it delivered in the same breath.
   *
   * Delivery is recorded optimistically - the panel cannot know the agent
   * received the response. That is the right trade: a command wrongly marked
   * delivered expires on its TTL, while re-delivering one the agent already ran
   * would restart a host twice.
   */
  collect(agentId: string, at: string): readonly CommandEnvelope[] {
    const open = this.repo.openFor(agentId).filter((r) => r.state === 'queued');
    if (open.length === 0) return [];
    this.repo.markDelivered(
      open.map((row) => row.id),
      at,
    );
    return open.map((row) => ({
      id: row.id,
      command: row.command,
      payload: row.payload ?? null,
    }));
  }

  /** What the agent reports after actually running something. */
  settle(
    agentId: string,
    outcomes: readonly CommandOutcome[],
    at: string,
  ): number {
    let settled = 0;
    for (const outcome of outcomes) {
      const row = this.repo.findCommand(outcome.id);
      // An outcome for someone else's command is either a bug or an agent
      // reaching past itself; neither should be able to settle a row.
      if (row === null || row.agentId !== agentId) {
        this.logger.warn('outcome for an unknown command', {
          agentId,
          id: outcome.id,
        });
        continue;
      }
      const applied = this.repo.settle(
        outcome.id,
        outcome.ok ? 'completed' : 'failed',
        at,
        outcome.detail ?? null,
      );
      if (applied) settled += 1;
    }
    return settled;
  }

  /**
   * The one command that cannot be acknowledged.
   *
   * The agent dies executing `restart`, so no outcome ever arrives for it.
   * Success is the agent reappearing as a *new process*: if what reports is
   * younger than the time since the command went out, it is not the process that
   * was told to restart. Host uptime cannot answer this - restarting a service
   * does not reboot the machine - which is why the report carries the agent's
   * own.
   */
  completeRestarts(agentId: string, report: HostReport, at: Date): void {
    for (const row of this.repo.deliveredFor(agentId)) {
      if (row.command !== 'restart' || row.deliveredAt === null) continue;
      const sinceDelivery = (at.getTime() - Date.parse(row.deliveredAt)) / 1000;
      if (report.agentUptimeSeconds <= sinceDelivery) {
        this.repo.settle(
          row.id,
          'completed',
          at.toISOString(),
          `agent came back after ${Math.round(report.agentUptimeSeconds)}s of uptime`,
        );
        this.logger.info('restart completed', { agentId, id: row.id });
      }
    }
  }

  /** Swept on a timer, so a command nobody wants stops being deliverable. */
  expire(now: Date = new Date()): number {
    const expired = this.repo.expire(now.toISOString());
    if (expired > 0) this.logger.info('commands expired', { expired });
    return expired;
  }

  list(state: 'open' | 'recent', limit: number): readonly CommandView[] {
    const rows = state === 'open' ? this.repo.open() : this.repo.recent(limit);
    return rows.slice(0, limit).map(toCommandView);
  }

  #requireAgent(agentId: string): AgentRow {
    const agent = this.repo.find(agentId);
    if (agent === null) {
      throw new HttpError(HttpStatusCode.NOT_FOUND, `No agent ${agentId}`);
    }
    return agent;
  }
}
