import { Logger } from '@dunx/core';
import { HttpError, HttpStatusCode } from '@dunx/http';
import { ScheduleKind, ScheduleRegistry } from '@dunx/infra/schedule';
import type {
  AgentCommandName,
  DiagnoseProbe,
  ScheduleAction,
  ScheduledTaskView,
} from '@beacon/contract';
import {
  AgentsRepository,
  type ScheduledTaskRow,
} from './agents.repository.js';
import { CommandsService } from './commands.service.js';
import { toScheduledTaskView, type ScheduleLiveState } from './agents.views.js';

/** What a new scheduled task looks like before the panel assigns it an id. */
export interface NewScheduledTask {
  readonly name: string;
  readonly agentId?: string | null | undefined;
  readonly action: ScheduleAction;
  readonly probe?: DiagnoseProbe | undefined;
  readonly libraryId?: string | undefined;
  readonly cron: string;
}

/** The command each action queues, so the open-command guard knows what to look for. */
const COMMAND_FOR: Record<ScheduleAction, AgentCommandName> = {
  report: 'report',
  inventory: 'inventory',
  diagnose: 'diagnose',
  exec: 'exec',
};

/**
 * Scheduled tasks: the panel queuing a command on a cadence instead of an
 * operator doing it by hand.
 *
 * The cadence is not hand-rolled - each task is a `Bun.cron` job in dunx's
 * `ScheduleRegistry`, which owns firing, overlap (a run still going at the next
 * fire is skipped), the next-fire computation and the run counters. This service
 * only persists the *definition* (so a schedule survives a restart) and arms /
 * disarms the registry as tasks are created, toggled and deleted. A task adds
 * *when*, not a new *what*: it reuses the command lifecycle whole, so a scheduled
 * run is indistinguishable from a manual one once queued, its output lands in the
 * same history, and a failure raises the same `command_failed` alert.
 */
export class ScheduleService {
  constructor(
    private readonly repo: AgentsRepository,
    private readonly commands: CommandsService,
    private readonly registry: ScheduleRegistry,
    private readonly logger: Logger,
  ) {}

  /**
   * Arm every enabled task at boot. Called from `AgentsService.onInit` *after*
   * the migration, so the table exists - the one ordering this depends on.
   * Per-task best-effort: a stored cron that no longer parses is logged and
   * skipped rather than failing the whole panel's start.
   */
  armPersisted(): void {
    let armed = 0;
    for (const row of this.repo.enabledSchedules()) {
      if (this.#arm(row)) armed += 1;
    }
    if (armed > 0) this.logger.info('scheduled tasks armed', { armed });
  }

  listTasks(): readonly ScheduledTaskView[] {
    const hostnames = new Map(this.repo.list().map((a) => [a.id, a.hostname]));
    const libraries = new Map(
      this.repo.listLibrary().map((l) => [l.id, l.name]),
    );
    return this.repo
      .listSchedules()
      .map((row) =>
        toScheduledTaskView(
          row,
          row.agentId === null ? null : (hostnames.get(row.agentId) ?? null),
          row.libraryId === null
            ? null
            : (libraries.get(row.libraryId) ?? null),
          this.#live(row.id),
        ),
      );
  }

  createTask(input: NewScheduledTask, by: string | null): ScheduledTaskView {
    const agentId = input.agentId ?? null;
    if (agentId !== null && this.repo.find(agentId) === null) {
      throw new HttpError(HttpStatusCode.NOT_FOUND, `No agent ${agentId}`);
    }
    const row: ScheduledTaskRow = {
      id: crypto.randomUUID(),
      name: input.name,
      agentId,
      action: input.action,
      probe: this.#requireProbe(input),
      libraryId: this.#requireLibrary(input),
      cron: input.cron,
      enabled: true,
      createdAt: new Date().toISOString(),
      createdBy: by,
    };
    // Arm first: `Bun.cron` rejects an unparseable expression here, so a bad cron
    // is a 400 rather than a row that never fires. Only persist once it is armed.
    this.#armOrThrow(row);
    this.repo.createSchedule(row);
    this.logger.info('scheduled task created', {
      name: row.name,
      action: row.action,
      cron: row.cron,
    });
    return this.#view(row);
  }

  deleteTask(id: string): void {
    if (this.repo.findSchedule(id) === null) {
      throw new HttpError(HttpStatusCode.NOT_FOUND, `No scheduled task ${id}`);
    }
    this.registry.remove(nameOf(id));
    this.repo.deleteSchedule(id);
  }

  setEnabled(id: string, enabled: boolean): void {
    const row = this.repo.findSchedule(id);
    if (row === null) {
      throw new HttpError(HttpStatusCode.NOT_FOUND, `No scheduled task ${id}`);
    }
    this.repo.setScheduleEnabled(id, enabled);
    if (enabled) this.#armOrThrow({ ...row, enabled });
    else this.registry.remove(nameOf(id));
  }

  /** Run a task now, off its cadence - what an operator (or a test) uses to force it. */
  async runNow(id: string): Promise<void> {
    if (this.repo.findSchedule(id) === null) {
      throw new HttpError(HttpStatusCode.NOT_FOUND, `No scheduled task ${id}`);
    }
    if (this.registry.get(nameOf(id)) === undefined) {
      throw new HttpError(
        HttpStatusCode.CONFLICT,
        'This task is paused; enable it before running it.',
      );
    }
    await this.registry.trigger(nameOf(id));
  }

  // --- Arming ----------------------------------------------------------------

  /** Arm a task, mapping an unparseable cron to a 400. */
  #armOrThrow(row: ScheduledTaskRow): void {
    try {
      this.registry.add(
        { kind: ScheduleKind.CRON, at: row.cron, name: nameOf(row.id) },
        () => this.#run(row),
      );
    } catch (error) {
      throw new HttpError(
        HttpStatusCode.BAD_REQUEST,
        `Invalid schedule "${row.cron}": ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /** Arm a task at boot; a bad one is logged and skipped, never fatal. */
  #arm(row: ScheduledTaskRow): boolean {
    try {
      this.registry.add(
        { kind: ScheduleKind.CRON, at: row.cron, name: nameOf(row.id) },
        () => this.#run(row),
      );
      return true;
    } catch (error) {
      this.logger.warn('could not arm scheduled task', {
        task: row.name,
        cron: row.cron,
        err: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  /** The registry handler: queue this task's command for each target agent. */
  #run(row: ScheduledTaskRow): void {
    const targets =
      row.agentId === null ? this.repo.list().map((a) => a.id) : [row.agentId];
    for (const agentId of targets) this.#queue(row, agentId);
  }

  /**
   * Queue one task's command for one agent. Best-effort per target: a bad one is
   * logged and the rest still run. Skipped when a command of the same kind is
   * already open for that agent, so a fast schedule cannot pile up work on a host
   * that has gone quiet.
   */
  #queue(task: ScheduledTaskRow, agentId: string): void {
    if (this.#hasOpenCommand(agentId, COMMAND_FOR[task.action])) return;
    const by = `schedule:${task.name}`;
    try {
      switch (task.action) {
        case 'report':
        case 'inventory':
          this.commands.queue(agentId, task.action, by);
          break;
        case 'diagnose':
          if (task.probe === null) return;
          this.commands.queueDiagnose(agentId, task.probe, by);
          break;
        case 'exec':
          if (task.libraryId === null) return;
          this.commands.queueExecLibrary(agentId, task.libraryId, by);
          break;
      }
    } catch (error) {
      this.logger.warn('scheduled task could not queue', {
        task: task.name,
        agentId,
        err: error instanceof Error ? error.message : String(error),
      });
    }
  }

  #hasOpenCommand(agentId: string, command: AgentCommandName): boolean {
    return this.repo.openFor(agentId).some((row) => row.command === command);
  }

  #requireProbe(input: NewScheduledTask): DiagnoseProbe | null {
    if (input.action !== 'diagnose') return null;
    if (input.probe === undefined) {
      throw new HttpError(
        HttpStatusCode.BAD_REQUEST,
        'A diagnose task needs a probe',
      );
    }
    return input.probe;
  }

  #requireLibrary(input: NewScheduledTask): string | null {
    if (input.action !== 'exec') return null;
    if (input.libraryId === undefined) {
      throw new HttpError(
        HttpStatusCode.BAD_REQUEST,
        'An exec task needs a library command',
      );
    }
    if (this.repo.findLibrary(input.libraryId) === null) {
      throw new HttpError(
        HttpStatusCode.NOT_FOUND,
        `No library command ${input.libraryId}`,
      );
    }
    return input.libraryId;
  }

  /** The live run state from the registry, or the empty state for a paused task. */
  #live(id: string): ScheduleLiveState {
    const entry = this.registry.get(nameOf(id));
    if (entry === undefined) {
      return { lastRunAt: null, nextRunAt: null, runs: 0, lastError: null };
    }
    return {
      lastRunAt: entry.lastRunAt?.toISOString() ?? null,
      nextRunAt: entry.nextRunAt?.toISOString() ?? null,
      runs: entry.runs,
      lastError: entry.lastError?.message ?? null,
    };
  }

  #view(row: ScheduledTaskRow): ScheduledTaskView {
    const agent = row.agentId === null ? null : this.repo.find(row.agentId);
    const library =
      row.libraryId === null ? null : this.repo.findLibrary(row.libraryId);
    return toScheduledTaskView(
      row,
      agent?.hostname ?? null,
      library?.name ?? null,
      this.#live(row.id),
    );
  }
}

/** The registry key for a task, namespaced so it cannot collide with a decorator's. */
const nameOf = (id: string): string => `task:${id}`;
