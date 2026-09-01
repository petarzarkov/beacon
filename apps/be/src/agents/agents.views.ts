import type {
  AgentCommandRow,
  AgentRow,
  DiscoveredHostRow,
} from './agents.repository.js';
import type {
  AgentView,
  CommandView,
  DiscoveryView,
} from './agents.schemas.js';

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
  // Null until the first report lands. An agent that has enrolled and not yet
  // reported is a state the console should show as such, not as a host with
  // zero memory.
  load1: row.lastReport?.load1 ?? null,
  memTotalBytes: row.lastReport?.memTotalBytes ?? null,
  memFreeBytes: row.lastReport?.memFreeBytes ?? null,
  reportedAt: row.lastReport?.collectedAt ?? null,
  connected: ctx.now - Date.parse(row.lastSeenAt) < ctx.offlineAfterMs,
  updateAvailable:
    ctx.releaseVersion !== null && ctx.releaseVersion !== row.agentVersion,
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
});

export const toDiscoveryView = (row: DiscoveredHostRow): DiscoveryView => ({
  address: row.address,
  hostname: row.hostname,
  ports: row.ports,
  foundBy: row.foundBy,
  lastSeenAt: row.lastSeenAt,
  enrolledAgentId: row.enrolledAgentId,
});
