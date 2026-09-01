import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import type {
  AgentCommandName,
  CommandState,
  DeployPayload,
  DiscoverPayload,
  HostReport,
} from '@dunxon/contract';

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
    /** `deploy` and `discover` carry one; the rest are the whole instruction. */
    payload: text('payload', { mode: 'json' }).$type<
      DeployPayload | DiscoverPayload
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
  },
  (table) => [index('agent_commands_open').on(table.agentId, table.state)],
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

export type AgentRow = typeof agents.$inferSelect;
export type AgentCommandRow = typeof agentCommands.$inferSelect;
export type DiscoveredHostRow = typeof discoveredHosts.$inferSelect;
export type FleetSettingRow = typeof fleetSettings.$inferSelect;
