import {
  index,
  integer,
  real,
  sqliteTable,
  text,
} from 'drizzle-orm/sqlite-core';
import type {
  AgentCommandName,
  AgentEventKind,
  AlertComparator,
  AlertMetric,
  AlertRuleKind,
  AlertState,
  CommandState,
  DeployPayload,
  DiagnosePayload,
  DiscoverPayload,
  ExecPayload,
  HostReport,
} from '@beacon/contract';

/**
 * An agent, keyed by an id the panel assigns at enrolment rather than by
 * hostname. Hostnames repeat across networks and change under an operator's
 * hands; an identity that moves when someone renames a host is not one.
 */
export const agents = sqliteTable(
  'agents',
  {
    id: text('id').primaryKey(),
    /**
     * What re-enrolment is matched on: stable across reinstalls of the same
     * host, so reinstalling replaces an identity rather than forking one and
     * scattering that machine's history across two rows.
     */
    machineId: text('machine_id').notNull().unique(),
    /**
     * sha256 of the token issued at enrolment. The panel cannot show a token
     * twice, which is the point - a readable column is a fleet-wide credential
     * sitting in every database backup.
     */
    tokenHash: text('token_hash').notNull(),
    hostname: text('hostname').notNull(),
    agentVersion: text('agent_version').notNull(),
    os: text('os').notNull(),
    arch: text('arch').notNull(),
    enrolledAt: text('enrolled_at').notNull(),
    lastSeenAt: text('last_seen_at').notNull(),
    /** The address the last report arrived from, for an operator matching a row to a box. */
    lastIp: text('last_ip'),
    uptimeSeconds: integer('uptime_seconds').notNull(),
    /**
     * The agent process's own uptime as of the last report. What makes a restart
     * observable: the agent cannot acknowledge one it died executing, so the
     * panel completes the command when this comes back younger than the time
     * since delivery.
     */
    agentUptimeSeconds: integer('agent_uptime_seconds').notNull(),
    /**
     * The whole last report, so a field added agent-side is not lost before the
     * panel knows it. Null between enrolment and the first report, which is a
     * real state an agent passes through rather than a zeroed placeholder.
     */
    lastReport: text('last_report', { mode: 'json' }).$type<HostReport>(),
    /**
     * The agent that deployed this one, when it arrived via a deployment grant
     * rather than the shared enrolment token. Null for the seed agent and for
     * any host enrolled by hand. Together with `found_by` in `discovered_hosts`,
     * this is what lets the console draw a "who installed whom" lineage tree.
     */
    installedBy: text('installed_by'),
  },
  (table) => [index('agents_last_seen').on(table.lastSeenAt)],
);

/**
 * A queued intent. The panel cannot reach an agent, so this is the only shape
 * control can take: something written down until the agent comes to collect it.
 */
export const agentCommands = sqliteTable(
  'agent_commands',
  {
    id: text('id').primaryKey(),
    agentId: text('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    command: text('command').$type<AgentCommandName>().notNull(),
    state: text('state').$type<CommandState>().notNull(),
    /** `deploy`, `discover`, `diagnose` and `exec` carry one; the rest are the whole instruction. */
    payload: text('payload', { mode: 'json' }).$type<
      DeployPayload | DiscoverPayload | DiagnosePayload | ExecPayload
    >(),
    queuedAt: text('queued_at').notNull(),
    /** Past this it is never delivered. An agent dark for a week must not come back to a restart. */
    expiresAt: text('expires_at').notNull(),
    deliveredAt: text('delivered_at'),
    settledAt: text('settled_at'),
    /** One line of outcome, or why it expired. */
    detail: text('detail'),
    /** The operator's user id. A queued restart is worth attributing. */
    issuedBy: text('issued_by'),
    /** For an `exec`, a human label of what ran (safe to show; payload is not). */
    label: text('label'),
  },
  (table) => [index('agent_commands_open').on(table.agentId, table.state)],
);

/**
 * The admin-curated library of named commands an operator can run on an agent.
 *
 * Tier 1 of custom commands: an operator picks an entry, the panel resolves it to
 * its argv and queues an `exec`. The allowlist lives here rather than on the
 * agent, so it can be curated centrally and an operator never submits raw argv.
 */
export const commandLibrary = sqliteTable('command_library', {
  id: text('id').primaryKey(),
  /** A short unique name shown in the console (e.g. `restart-nginx`). */
  name: text('name').notNull().unique(),
  description: text('description'),
  /** The exact argv the agent runs. JSON array of strings. */
  argv: text('argv', { mode: 'json' }).$type<string[]>().notNull(),
  createdAt: text('created_at').notNull(),
  createdBy: text('created_by'),
});

/**
 * An alerting rule, evaluated fleet-wide. Kept on the panel because the panel is
 * where every report lands - a threshold or a silence is judged here, not by the
 * agent. `enabled` lets a rule be paused without deleting it.
 */
export const alertRules = sqliteTable('alert_rules', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  kind: text('kind').$type<AlertRuleKind>().notNull(),
  metric: text('metric').$type<AlertMetric>(),
  comparator: text('comparator').$type<AlertComparator>(),
  threshold: real('threshold'),
  silenceSeconds: integer('silence_seconds'),
  enabled: integer('enabled', { mode: 'boolean' }).notNull(),
  createdAt: text('created_at').notNull(),
  createdBy: text('created_by'),
});

/**
 * A fired alert. Deduped to one active row per (rule, agent): a condition that
 * stays true does not pile up, it updates the one alert. Metric and silence
 * alerts resolve themselves when the condition clears; a `command_failed` one is
 * a point event an operator acknowledges.
 */
export const alerts = sqliteTable(
  'alerts',
  {
    id: text('id').primaryKey(),
    ruleId: text('rule_id')
      .notNull()
      .references(() => alertRules.id, { onDelete: 'cascade' }),
    agentId: text('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    state: text('state').$type<AlertState>().notNull(),
    message: text('message').notNull(),
    value: real('value'),
    firedAt: text('fired_at').notNull(),
    updatedAt: text('updated_at').notNull(),
    resolvedAt: text('resolved_at'),
    acknowledgedAt: text('acknowledged_at'),
    acknowledgedBy: text('acknowledged_by'),
  },
  (table) => [index('alerts_agent_state').on(table.agentId, table.state)],
);

/**
 * A lifecycle event an agent reported - it started, it stopped. Kept as a small
 * append-only log per host, so the console can show a machine coming and going
 * rather than leaving an operator to infer it from a gap between reports.
 */
export const agentEvents = sqliteTable(
  'agent_events',
  {
    id: text('id').primaryKey(),
    agentId: text('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    kind: text('kind').$type<AgentEventKind>().notNull(),
    message: text('message').notNull(),
    /** When it happened on the host, as the agent reported it. */
    at: text('at').notNull(),
    /** When the panel recorded it; differs from `at` if the agent was offline. */
    receivedAt: text('received_at').notNull(),
  },
  (table) => [index('agent_events_agent').on(table.agentId, table.receivedAt)],
);

/**
 * A bounded time series of an agent's metrics - one row per report, pruned past
 * a retention window. The last report answers "what is it now"; this answers
 * "what has it been doing", which is where a slow leak or a load spike shows.
 */
export const agentMetrics = sqliteTable(
  'agent_metrics',
  {
    id: text('id').primaryKey(),
    agentId: text('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    /** When the sample was collected on the host. */
    at: text('at').notNull(),
    /** The agent process's resident memory (RSS). */
    memBytes: integer('mem_bytes').notNull(),
    /** The agent process's CPU, percent of one core. Null with no baseline. */
    cpuPercent: real('cpu_percent'),
    /** The host's 1-minute load, kept for context. */
    load1: real('load1').notNull(),
  },
  (table) => [index('agent_metrics_agent_at').on(table.agentId, table.at)],
);

/**
 * A host an agent found on its subnet. Recorded, never acted on: what turns one
 * of these into a managed machine is a human approving a deployment.
 */
export const discoveredHosts = sqliteTable(
  'discovered_hosts',
  {
    /** `${agentId}:${address}` - one row per finder per address, so a re-sweep updates. */
    id: text('id').primaryKey(),
    /** The agent that can reach it, and therefore the one that could deploy to it. */
    foundBy: text('found_by')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    address: text('address').notNull(),
    hostname: text('hostname'),
    ports: text('ports', { mode: 'json' }).$type<number[]>().notNull(),
    firstSeenAt: text('first_seen_at').notNull(),
    lastSeenAt: text('last_seen_at').notNull(),
    /** Set once a host enrols, so a swept subnet stops re-offering what is already managed. */
    enrolledAgentId: text('enrolled_agent_id'),
  },
  (table) => [index('discovered_address').on(table.address)],
);

/**
 * Fleet-wide settings a live operator can change, as key/value.
 *
 * A table rather than config, because the point is a switch that flips without a
 * restart - `propagation_allowed` is the kill switch, and a config value would
 * mean redeploying the panel to pause a fleet that is spreading. One row per
 * setting, so adding another is not a migration.
 */
export const fleetSettings = sqliteTable('fleet_settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedAt: text('updated_at').notNull(),
  /** The operator who last changed it, for the audit trail. */
  updatedBy: text('updated_by'),
});

/**
 * A deployment grant consumed on first use.
 *
 * Grants are scoped to one address and expire after a few minutes, which limits
 * the blast radius of a leaked one. Making them single-use closes the remaining
 * window: a grant captured in transit can no longer be replayed for the rest of
 * its TTL. The primary key is the sha256 of the raw grant string — the same
 * function used everywhere else in this codebase to avoid storing secrets in
 * plaintext.
 */
export const usedGrants = sqliteTable('used_grants', {
  grantHash: text('grant_hash').primaryKey(),
  usedAt: text('used_at').notNull(),
});

export type AgentRow = typeof agents.$inferSelect;
export type AgentCommandRow = typeof agentCommands.$inferSelect;
export type AgentEventRow = typeof agentEvents.$inferSelect;
export type AgentMetricRow = typeof agentMetrics.$inferSelect;
export type CommandLibraryRow = typeof commandLibrary.$inferSelect;
export type AlertRuleRow = typeof alertRules.$inferSelect;
export type AlertRow = typeof alerts.$inferSelect;
export type DiscoveredHostRow = typeof discoveredHosts.$inferSelect;
export type FleetSettingRow = typeof fleetSettings.$inferSelect;
export type UsedGrantRow = typeof usedGrants.$inferSelect;
