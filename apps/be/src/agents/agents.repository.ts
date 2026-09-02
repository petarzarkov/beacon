/* eslint-disable max-lines -- this is by design the one file that holds every SQL
   statement for the agents feature (see AGENTS.md); it grows with the feature. */
import { SyncDatabase } from '@dunx/infra/db';
import { and, count, desc, eq, gte, inArray, lt, sql } from 'drizzle-orm';
import * as schema from '../database/schema.js';
import { SETTLED_STATES, type CommandState } from '@beacon/contract';
import {
  agentCommands,
  agentEvents,
  agentInventory,
  agentMetrics,
  agents,
  alertRules,
  alerts,
  commandLibrary,
  discoveredHosts,
  fleetSettings,
  scheduledTasks,
  usedGrants,
  type AgentCommandRow,
  type AgentEventRow,
  type AgentInventoryRow,
  type AgentMetricRow,
  type AgentRow,
  type AlertRow,
  type AlertRuleRow,
  type CommandLibraryRow,
  type DiscoveredHostRow,
  type ScheduledTaskRow,
} from './agents.schema.js';

export type {
  AgentCommandRow,
  AgentEventRow,
  AgentInventoryRow,
  AgentMetricRow,
  AgentRow,
  AlertRow,
  AlertRuleRow,
  CommandLibraryRow,
  DiscoveredHostRow,
  ScheduledTaskRow,
};

/** The alert states that count as still open. */
export const ACTIVE_ALERT_STATES = ['firing', 'acknowledged'] as const;

/** The states a command can still be delivered or settled from. */
export const OPEN_STATES = ['queued', 'delivered'] as const;

/**
 * Every statement the agents feature runs, and nothing else. Synchronous
 * throughout because `DatabaseModule` opens SQLite in sync mode - a `Promise`
 * around a `bun:sqlite` call would buy nothing but a microtask.
 */
export class AgentsRepository {
  constructor(private readonly db: SyncDatabase<typeof schema>) {}

  /**
   * Standing in for a migration. The panel's default database is a file now, so
   * this runs once and finds its work done afterwards - but it still has to be
   * `IF NOT EXISTS` for the `:memory:` database the tests use.
   */
  migrate(): void {
    this.db.run(sql`CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY,
      machine_id TEXT NOT NULL UNIQUE,
      token_hash TEXT NOT NULL,
      hostname TEXT NOT NULL,
      agent_version TEXT NOT NULL,
      os TEXT NOT NULL,
      arch TEXT NOT NULL,
      enrolled_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      last_ip TEXT,
      uptime_seconds INTEGER NOT NULL,
      agent_uptime_seconds INTEGER NOT NULL,
      last_report TEXT,
      installed_by TEXT
    )`);
    // Additive migration for databases that existed before `installed_by` was
    // added. `IF NOT EXISTS` is not supported by SQLite for ADD COLUMN, so the
    // try/catch is the idiomatic approach: it is a no-op on a fresh database
    // that has the column from the CREATE TABLE above.
    try {
      this.db.run(sql`ALTER TABLE agents ADD COLUMN installed_by TEXT`);
    } catch {
      /* already present */
    }
    this.db.run(sql`CREATE TABLE IF NOT EXISTS agent_commands (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      command TEXT NOT NULL,
      state TEXT NOT NULL,
      payload TEXT,
      queued_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      delivered_at TEXT,
      settled_at TEXT,
      detail TEXT,
      issued_by TEXT,
      label TEXT
    )`);
    // Additive: `label` was added with the `exec` command. No-op on a fresh DB.
    try {
      this.db.run(sql`ALTER TABLE agent_commands ADD COLUMN label TEXT`);
    } catch {
      /* already present */
    }
    this.db.run(sql`CREATE TABLE IF NOT EXISTS command_library (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      description TEXT,
      argv TEXT NOT NULL,
      created_at TEXT NOT NULL,
      created_by TEXT
    )`);
    this.db.run(sql`CREATE TABLE IF NOT EXISTS alert_rules (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      kind TEXT NOT NULL,
      metric TEXT,
      comparator TEXT,
      threshold REAL,
      silence_seconds INTEGER,
      enabled INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      created_by TEXT
    )`);
    this.db.run(sql`CREATE TABLE IF NOT EXISTS alerts (
      id TEXT PRIMARY KEY,
      rule_id TEXT NOT NULL REFERENCES alert_rules(id) ON DELETE CASCADE,
      agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      state TEXT NOT NULL,
      message TEXT NOT NULL,
      value REAL,
      fired_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      resolved_at TEXT,
      acknowledged_at TEXT,
      acknowledged_by TEXT
    )`);
    this.db.run(sql`CREATE TABLE IF NOT EXISTS agent_events (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      message TEXT NOT NULL,
      at TEXT NOT NULL,
      received_at TEXT NOT NULL
    )`);
    this.db.run(sql`CREATE TABLE IF NOT EXISTS agent_metrics (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      at TEXT NOT NULL,
      mem_bytes INTEGER NOT NULL,
      cpu_percent REAL,
      load1 REAL NOT NULL
    )`);
    this.db.run(sql`CREATE TABLE IF NOT EXISTS agent_inventory (
      agent_id TEXT PRIMARY KEY REFERENCES agents(id) ON DELETE CASCADE,
      data TEXT NOT NULL,
      received_at TEXT NOT NULL
    )`);
    this.db.run(sql`CREATE TABLE IF NOT EXISTS scheduled_tasks (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      agent_id TEXT REFERENCES agents(id) ON DELETE CASCADE,
      action TEXT NOT NULL,
      probe TEXT,
      library_id TEXT REFERENCES command_library(id) ON DELETE CASCADE,
      cron TEXT NOT NULL,
      enabled INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      created_by TEXT
    )`);
    this.db.run(sql`CREATE TABLE IF NOT EXISTS discovered_hosts (
      id TEXT PRIMARY KEY,
      found_by TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      address TEXT NOT NULL,
      hostname TEXT,
      ports TEXT NOT NULL,
      first_seen_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      enrolled_agent_id TEXT
    )`);
    this.db.run(sql`CREATE TABLE IF NOT EXISTS fleet_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      updated_by TEXT
    )`);
    this.db.run(sql`CREATE TABLE IF NOT EXISTS used_grants (
      grant_hash TEXT PRIMARY KEY,
      used_at TEXT NOT NULL
    )`);
    this.db.run(
      sql`CREATE INDEX IF NOT EXISTS agents_last_seen ON agents (last_seen_at)`,
    );
    this.db.run(
      sql`CREATE INDEX IF NOT EXISTS agent_commands_open ON agent_commands (agent_id, state)`,
    );
    this.db.run(
      sql`CREATE INDEX IF NOT EXISTS discovered_address ON discovered_hosts (address)`,
    );
    this.db.run(
      sql`CREATE INDEX IF NOT EXISTS agent_events_agent ON agent_events (agent_id, received_at)`,
    );
    this.db.run(
      sql`CREATE INDEX IF NOT EXISTS agent_metrics_agent_at ON agent_metrics (agent_id, at)`,
    );
    this.db.run(
      sql`CREATE INDEX IF NOT EXISTS alerts_agent_state ON alerts (agent_id, state)`,
    );
  }

  // --- Alert rules -----------------------------------------------------------

  listRules(): readonly AlertRuleRow[] {
    return this.db
      .select()
      .from(alertRules)
      .orderBy(alertRules.createdAt)
      .all();
  }

  enabledRules(): readonly AlertRuleRow[] {
    return this.db
      .select()
      .from(alertRules)
      .where(eq(alertRules.enabled, true))
      .all();
  }

  findRule(id: string): AlertRuleRow | null {
    return (
      this.db.select().from(alertRules).where(eq(alertRules.id, id)).get() ??
      null
    );
  }

  createRule(row: AlertRuleRow): void {
    this.db.insert(alertRules).values(row).run();
  }

  deleteRule(id: string): boolean {
    return (
      this.db.delete(alertRules).where(eq(alertRules.id, id)).returning().all()
        .length > 0
    );
  }

  // --- Alerts ----------------------------------------------------------------

  /** The open alert for a (rule, agent), or null - the dedupe key. */
  activeAlert(ruleId: string, agentId: string): AlertRow | null {
    return (
      this.db
        .select()
        .from(alerts)
        .where(
          and(
            eq(alerts.ruleId, ruleId),
            eq(alerts.agentId, agentId),
            inArray(alerts.state, [...ACTIVE_ALERT_STATES]),
          ),
        )
        .get() ?? null
    );
  }

  insertAlert(row: AlertRow): void {
    this.db.insert(alerts).values(row).run();
  }

  /** Refresh an open alert's observed value while its condition still holds. */
  touchAlert(id: string, updatedAt: string, value: number | null): void {
    this.db
      .update(alerts)
      .set({ updatedAt, value })
      .where(eq(alerts.id, id))
      .run();
  }

  resolveAlert(id: string, at: string): void {
    this.db
      .update(alerts)
      .set({ state: 'resolved', resolvedAt: at, updatedAt: at })
      .where(eq(alerts.id, id))
      .run();
  }

  ackAlert(id: string, at: string, by: string | null): boolean {
    return (
      this.db
        .update(alerts)
        .set({
          state: 'acknowledged',
          acknowledgedAt: at,
          acknowledgedBy: by,
          updatedAt: at,
        })
        .where(and(eq(alerts.id, id), eq(alerts.state, 'firing')))
        .returning()
        .all().length > 0
    );
  }

  findAlert(id: string): AlertRow | null {
    return this.db.select().from(alerts).where(eq(alerts.id, id)).get() ?? null;
  }

  /** Open alerts (newest first) for the console; `all` also includes resolved. */
  listAlerts(scope: 'active' | 'all', limit: number): readonly AlertRow[] {
    const query = this.db.select().from(alerts);
    const rows =
      scope === 'active'
        ? query.where(inArray(alerts.state, [...ACTIVE_ALERT_STATES]))
        : query;
    return rows.orderBy(desc(alerts.firedAt)).limit(limit).all();
  }

  countActiveAlerts(): number {
    return (
      this.db
        .select({ n: count() })
        .from(alerts)
        .where(inArray(alerts.state, [...ACTIVE_ALERT_STATES]))
        .get()?.n ?? 0
    );
  }

  find(id: string): AgentRow | null {
    return this.db.select().from(agents).where(eq(agents.id, id)).get() ?? null;
  }

  /**
   * The whole of agent authentication. The column holds a sha256, so this is a
   * lookup by digest rather than by secret - a database dump is not a set of
   * usable fleet credentials.
   */
  findByTokenHash(tokenHash: string): AgentRow | null {
    return (
      this.db
        .select()
        .from(agents)
        .where(eq(agents.tokenHash, tokenHash))
        .get() ?? null
    );
  }

  findByMachineId(machineId: string): AgentRow | null {
    return (
      this.db
        .select()
        .from(agents)
        .where(eq(agents.machineId, machineId))
        .get() ?? null
    );
  }

  list(): readonly AgentRow[] {
    return this.db.select().from(agents).orderBy(agents.hostname).all();
  }

  count(): number {
    return this.db.select({ n: count() }).from(agents).get()?.n ?? 0;
  }

  /**
   * Enrolment, and re-enrolment onto the same row.
   *
   * `machineId` is the conflict target rather than `id`, so a host that is wiped
   * and re-enrolled keeps its command history instead of appearing twice.
   * `enrolledAt` is absent from the update on purpose: it is the one column a
   * later enrolment must not move.
   */
  enrol(row: AgentRow): void {
    this.db
      .insert(agents)
      .values(row)
      .onConflictDoUpdate({
        target: agents.machineId,
        set: {
          tokenHash: row.tokenHash,
          hostname: row.hostname,
          agentVersion: row.agentVersion,
          os: row.os,
          arch: row.arch,
          lastSeenAt: row.lastSeenAt,
          lastIp: row.lastIp,
          uptimeSeconds: row.uptimeSeconds,
          agentUptimeSeconds: row.agentUptimeSeconds,
          lastReport: row.lastReport,
          // installedBy deliberately omitted: re-enrolment must not erase
          // who originally deployed this host.
        },
      })
      .run();
  }

  /**
   * Which agent found an address on its sweep, i.e. the one that deployed to it.
   * Used to record propagation lineage on the new agent's row at enrolment.
   */
  installerFor(address: string): string | null {
    return (
      this.db
        .select({ foundBy: discoveredHosts.foundBy })
        .from(discoveredHosts)
        .where(eq(discoveredHosts.address, address))
        .orderBy(desc(discoveredHosts.lastSeenAt))
        .get()?.foundBy ?? null
    );
  }

  /**
   * Atomically marks a deployment grant as spent.
   *
   * Returns `true` when the grant was newly recorded (first use), `false` when
   * it was already present (replay). The primary key conflict is the race guard:
   * two simultaneous enrolments with the same grant cannot both succeed.
   */
  markGrantUsed(grantHash: string, at: string): boolean {
    return (
      this.db
        .insert(usedGrants)
        .values({ grantHash, usedAt: at })
        .onConflictDoNothing()
        .returning()
        .all().length > 0
    );
  }

  /** What a report changes, which is deliberately not the agent's identity. */
  recordReport(
    id: string,
    patch: Pick<
      AgentRow,
      | 'hostname'
      | 'agentVersion'
      | 'os'
      | 'arch'
      | 'lastSeenAt'
      | 'lastIp'
      | 'uptimeSeconds'
      | 'agentUptimeSeconds'
      | 'lastReport'
    >,
  ): void {
    this.db.update(agents).set(patch).where(eq(agents.id, id)).run();
  }

  remove(id: string): boolean {
    return (
      this.db.delete(agents).where(eq(agents.id, id)).returning().all().length >
      0
    );
  }

  /** Append lifecycle events. Cheap and append-only: a host's log, in order. */
  recordEvents(rows: readonly AgentEventRow[]): void {
    if (rows.length === 0) return;
    this.db
      .insert(agentEvents)
      .values([...rows])
      .run();
  }

  /** Newest first, for the detail page: a host's recent comings and goings. */
  eventsFor(agentId: string, limit: number): readonly AgentEventRow[] {
    return this.db
      .select()
      .from(agentEvents)
      .where(eq(agentEvents.agentId, agentId))
      .orderBy(desc(agentEvents.receivedAt))
      .limit(limit)
      .all();
  }

  /** One sample of an agent's metrics, appended per report. */
  recordMetric(row: AgentMetricRow): void {
    this.db.insert(agentMetrics).values(row).run();
  }

  /** A window of an agent's history, oldest first, so a chart reads left to right. */
  metricsSince(agentId: string, sinceIso: string): readonly AgentMetricRow[] {
    return this.db
      .select()
      .from(agentMetrics)
      .where(
        and(eq(agentMetrics.agentId, agentId), gte(agentMetrics.at, sinceIso)),
      )
      .orderBy(agentMetrics.at)
      .all();
  }

  /** Drops samples past the retention window. Returns how many went. */
  pruneMetrics(beforeIso: string): number {
    return this.db
      .delete(agentMetrics)
      .where(lt(agentMetrics.at, beforeIso))
      .returning()
      .all().length;
  }

  // --- Inventory -------------------------------------------------------------

  /** Store a host's latest inventory snapshot, replacing any earlier one. */
  recordInventory(row: AgentInventoryRow): void {
    this.db
      .insert(agentInventory)
      .values(row)
      .onConflictDoUpdate({
        target: agentInventory.agentId,
        set: { data: row.data, receivedAt: row.receivedAt },
      })
      .run();
  }

  /** The latest inventory for one host, or null if it has never reported one. */
  inventoryFor(agentId: string): AgentInventoryRow | null {
    return (
      this.db
        .select()
        .from(agentInventory)
        .where(eq(agentInventory.agentId, agentId))
        .get() ?? null
    );
  }

  // --- Scheduled tasks -------------------------------------------------------

  listSchedules(): readonly ScheduledTaskRow[] {
    return this.db
      .select()
      .from(scheduledTasks)
      .orderBy(scheduledTasks.createdAt)
      .all();
  }

  findSchedule(id: string): ScheduledTaskRow | null {
    return (
      this.db
        .select()
        .from(scheduledTasks)
        .where(eq(scheduledTasks.id, id))
        .get() ?? null
    );
  }

  createSchedule(row: ScheduledTaskRow): void {
    this.db.insert(scheduledTasks).values(row).run();
  }

  deleteSchedule(id: string): boolean {
    return (
      this.db
        .delete(scheduledTasks)
        .where(eq(scheduledTasks.id, id))
        .returning()
        .all().length > 0
    );
  }

  setScheduleEnabled(id: string, enabled: boolean): boolean {
    return (
      this.db
        .update(scheduledTasks)
        .set({ enabled })
        .where(eq(scheduledTasks.id, id))
        .returning()
        .all().length > 0
    );
  }

  /** Enabled tasks, for arming the registry at boot. */
  enabledSchedules(): readonly ScheduledTaskRow[] {
    return this.db
      .select()
      .from(scheduledTasks)
      .where(eq(scheduledTasks.enabled, true))
      .all();
  }

  queue(row: AgentCommandRow): void {
    this.db.insert(agentCommands).values(row).run();
  }

  // --- The command library (Tier 1) ------------------------------------------

  listLibrary(): readonly CommandLibraryRow[] {
    return this.db
      .select()
      .from(commandLibrary)
      .orderBy(commandLibrary.name)
      .all();
  }

  findLibrary(id: string): CommandLibraryRow | null {
    return (
      this.db
        .select()
        .from(commandLibrary)
        .where(eq(commandLibrary.id, id))
        .get() ?? null
    );
  }

  createLibraryEntry(row: CommandLibraryRow): void {
    this.db.insert(commandLibrary).values(row).run();
  }

  deleteLibraryEntry(id: string): boolean {
    return (
      this.db
        .delete(commandLibrary)
        .where(eq(commandLibrary.id, id))
        .returning()
        .all().length > 0
    );
  }

  findCommand(id: string): AgentCommandRow | null {
    return (
      this.db
        .select()
        .from(agentCommands)
        .where(eq(agentCommands.id, id))
        .get() ?? null
    );
  }

  /** Oldest first: a command queued earlier is delivered earlier. */
  openFor(agentId: string): readonly AgentCommandRow[] {
    return this.db
      .select()
      .from(agentCommands)
      .where(
        and(
          eq(agentCommands.agentId, agentId),
          inArray(agentCommands.state, [...OPEN_STATES]),
        ),
      )
      .orderBy(agentCommands.queuedAt)
      .all();
  }

  deliveredFor(agentId: string): readonly AgentCommandRow[] {
    return this.db
      .select()
      .from(agentCommands)
      .where(
        and(
          eq(agentCommands.agentId, agentId),
          eq(agentCommands.state, 'delivered'),
        ),
      )
      .all();
  }

  /** Newest first, for the console: what is outstanding right now. */
  open(): readonly AgentCommandRow[] {
    return this.db
      .select()
      .from(agentCommands)
      .where(inArray(agentCommands.state, [...OPEN_STATES]))
      .orderBy(desc(agentCommands.queuedAt))
      .all();
  }

  recent(limit: number): readonly AgentCommandRow[] {
    return this.db
      .select()
      .from(agentCommands)
      .orderBy(desc(agentCommands.queuedAt))
      .limit(limit)
      .all();
  }

  markDelivered(ids: readonly string[], at: string): void {
    if (ids.length === 0) return;
    this.db
      .update(agentCommands)
      .set({ state: 'delivered', deliveredAt: at })
      .where(inArray(agentCommands.id, [...ids]))
      .run();
  }

  /**
   * Settling is conditional on the command still being open, so a duplicate
   * outcome from an agent that retried cannot reopen a settled row or overwrite
   * the first answer with a second one.
   */
  settle(
    id: string,
    state: CommandState,
    at: string,
    detail: string | null,
  ): boolean {
    return (
      this.db
        .update(agentCommands)
        .set({ state, settledAt: at, detail })
        .where(
          and(
            eq(agentCommands.id, id),
            inArray(agentCommands.state, [...OPEN_STATES]),
          ),
        )
        .returning()
        .all().length > 0
    );
  }

  /** Everything past its TTL, so nothing is delivered that nobody still wants. */
  expire(now: string): number {
    return this.db
      .update(agentCommands)
      .set({
        state: 'expired',
        settledAt: now,
        detail: 'not collected before the TTL',
      })
      .where(
        and(
          inArray(agentCommands.state, [...OPEN_STATES]),
          lt(agentCommands.expiresAt, now),
        ),
      )
      .returning()
      .all().length;
  }

  /** How many commands have ever settled badly, for the readiness probe. */
  countByStates(states: readonly CommandState[]): number {
    return (
      this.db
        .select({ n: count() })
        .from(agentCommands)
        .where(inArray(agentCommands.state, [...states]))
        .get()?.n ?? 0
    );
  }

  countSettled(): number {
    return this.countByStates(SETTLED_STATES);
  }

  recordDiscovery(row: DiscoveredHostRow): void {
    this.db
      .insert(discoveredHosts)
      .values(row)
      .onConflictDoUpdate({
        target: discoveredHosts.id,
        set: {
          hostname: row.hostname,
          ports: row.ports,
          lastSeenAt: row.lastSeenAt,
        },
      })
      .run();
  }

  /** Marks a swept address as managed, so the console stops offering it. */
  linkDiscovery(address: string, agentId: string): void {
    this.db
      .update(discoveredHosts)
      .set({ enrolledAgentId: agentId })
      .where(eq(discoveredHosts.address, address))
      .run();
  }

  discoveries(): readonly DiscoveredHostRow[] {
    return this.db
      .select()
      .from(discoveredHosts)
      .orderBy(desc(discoveredHosts.lastSeenAt))
      .all();
  }

  /** The agent that most recently saw an address, and so the one that can reach it. */
  finderOf(address: string): DiscoveredHostRow | null {
    return (
      this.db
        .select()
        .from(discoveredHosts)
        .where(eq(discoveredHosts.address, address))
        .orderBy(desc(discoveredHosts.lastSeenAt))
        .get() ?? null
    );
  }

  /** `null` when the setting has never been written, which the caller reads as its default. */
  setting(key: string): string | null {
    return (
      this.db
        .select()
        .from(fleetSettings)
        .where(eq(fleetSettings.key, key))
        .get()?.value ?? null
    );
  }

  putSetting(key: string, value: string, at: string, by: string | null): void {
    this.db
      .insert(fleetSettings)
      .values({ key, value, updatedAt: at, updatedBy: by })
      .onConflictDoUpdate({
        target: fleetSettings.key,
        set: { value, updatedAt: at, updatedBy: by },
      })
      .run();
  }
}
