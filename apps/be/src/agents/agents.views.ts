import type {
  AgentCommandRow,
  AgentEventRow,
  AgentInventoryRow,
  AgentMetricRow,
  AgentRow,
  CommandLibraryRow,
  DiscoveredHostRow,
  ScheduledTaskRow,
} from './agents.repository.js';
import type {
  AgentEventView,
  AgentMetricPoint,
  AgentView,
  CommandLibraryEntry,
  CommandView,
  DiscoveryView,
  InventoryView,
  ScheduledTaskView,
} from '@beacon/contract';

/**
 * Rows to what the console is shown. Separate from the repository because the
 * two shapes differ on purpose: `tokenHash` must never leave the panel, and
 * `connected` is not a column at all.
 */

export interface ViewContext {
  /** Silence longer than this and an agent is not connected, whatever it was. */
  readonly offlineAfterMs: number;
  /** The published version, or null when nothing has been built yet. */
  readonly releaseVersion: string | null;
  readonly now: number;
}

/**
 * `connected` is derived, and that is the honest answer.
 *
 * The panel never dials an agent, so it has no way to ask whether one is up. All
 * it knows is when the agent last came to it. A stored flag would be a cache of
 * this same subtraction that goes stale the moment an agent stops reporting -
 * which is precisely the case it exists to catch.
 */
export const toAgentView = (row: AgentRow, ctx: ViewContext): AgentView => ({
  id: row.id,
  hostname: row.hostname,
  agentVersion: row.agentVersion,
  os: row.os,
  arch: row.arch,
  enrolledAt: row.enrolledAt,
  lastSeenAt: row.lastSeenAt,
  lastIp: row.lastIp,
  uptimeSeconds: row.uptimeSeconds,
  agentUptimeSeconds: row.agentUptimeSeconds,
  // The agent's own footprint, not the host's. Null until the first report, and
  // `0` (an old agent that does not send it) reads as unknown too - a live
  // process is never actually at zero RSS.
  agentMemBytes: row.lastReport?.agentMemBytes || null,
  agentCpuPercent: row.lastReport?.agentCpuPercent ?? null,
  reportedAt: row.lastReport?.collectedAt ?? null,
  connected: ctx.now - Date.parse(row.lastSeenAt) < ctx.offlineAfterMs,
  updateAvailable:
    ctx.releaseVersion !== null && ctx.releaseVersion !== row.agentVersion,
  installedBy: row.installedBy ?? null,
  propagateEnabled: row.lastReport?.propagateEnabled ?? false,
});

/**
 * A command's `payload` is deliberately absent. It carries the SSH credential
 * for a deployment, and the console has no use for it that is worth the risk of
 * serving it back.
 */
export const toCommandView = (row: AgentCommandRow): CommandView => ({
  id: row.id,
  agentId: row.agentId,
  command: row.command,
  state: row.state,
  queuedAt: row.queuedAt,
  expiresAt: row.expiresAt,
  deliveredAt: row.deliveredAt,
  settledAt: row.settledAt,
  detail: row.detail,
  issuedBy: row.issuedBy,
  label: row.label ?? null,
});

/** The argv is safe to show for a library entry (unlike a deploy credential). */
export const toLibraryEntryView = (
  row: CommandLibraryRow,
): CommandLibraryEntry => ({
  id: row.id,
  name: row.name,
  description: row.description,
  argv: row.argv,
  createdBy: row.createdBy,
  createdAt: row.createdAt,
});

export const toAgentEventView = (row: AgentEventRow): AgentEventView => ({
  id: row.id,
  agentId: row.agentId,
  kind: row.kind,
  message: row.message,
  at: row.at,
  receivedAt: row.receivedAt,
});

export const toMetricPoint = (row: AgentMetricRow): AgentMetricPoint => ({
  at: row.at,
  memBytes: row.memBytes,
  cpuPercent: row.cpuPercent,
  load1: row.load1,
});

/** The stored snapshot plus who and when. The JSON blob is the wire shape already. */
export const toInventoryView = (row: AgentInventoryRow): InventoryView => ({
  ...row.data,
  agentId: row.agentId,
  receivedAt: row.receivedAt,
});

/** The live run state of a scheduled task, read from the framework's registry. */
export interface ScheduleLiveState {
  readonly lastRunAt: string | null;
  readonly nextRunAt: string | null;
  readonly runs: number;
  readonly lastError: string | null;
}

/**
 * The stored definition, the names resolved for the console, and the live run
 * state from the `ScheduleRegistry` (which owns the cadence and the counters).
 */
export const toScheduledTaskView = (
  row: ScheduledTaskRow,
  agentHostname: string | null,
  libraryName: string | null,
  live: ScheduleLiveState,
): ScheduledTaskView => ({
  id: row.id,
  name: row.name,
  agentId: row.agentId,
  agentHostname,
  action: row.action,
  probe: row.probe,
  libraryId: row.libraryId,
  libraryName,
  cron: row.cron,
  enabled: row.enabled,
  lastRunAt: live.lastRunAt,
  nextRunAt: live.nextRunAt,
  runs: live.runs,
  lastError: live.lastError,
  createdAt: row.createdAt,
  createdBy: row.createdBy,
});

export const toDiscoveryView = (row: DiscoveredHostRow): DiscoveryView => ({
  address: row.address,
  hostname: row.hostname,
  ports: row.ports,
  foundBy: row.foundBy,
  lastSeenAt: row.lastSeenAt,
  enrolledAgentId: row.enrolledAgentId,
});
