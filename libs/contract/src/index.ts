/**
 * `@dunxon/contract` - the wire contract between panel, agent and console, and
 * the one definition of it.
 *
 * **This package imports nothing, deliberately.** All three apps depend on it,
 * and the agent compiles to a single binary; a dependency here would drag
 * whatever it pulled in into that binary and into the browser bundle. So this is
 * types and string constants only. The panel's zod schemas that *validate* these
 * on the way in live in `apps/be`, where zod is already a dependency; the shapes
 * they parse into are the ones declared here, so the two cannot drift.
 *
 * It replaces the old cross-package aliases (`@be/*`, `@agent/*`): nothing
 * reaches into another app's `src` for a type any more.
 */

/** Presented by an enrolled agent on every call. Per-agent, issued at enrolment. */
export const AGENT_HEADER = 'x-agent-token';

/**
 * Presented once, to enrol. Shared across the fleet, so it buys an identity and
 * nothing else: it can create an agent and cannot read one.
 */
export const ENROLMENT_HEADER = 'x-enrolment-token';

/** Written beside the binary by the agent's build script. */
export const MANIFEST_FILE = 'manifest.json';

/** What the panel publishes beside the binary, and what an update verifies against. */
export interface ReleaseManifest {
  readonly version: string;
  /** Hex sha256 of the binary. The agent refuses to install a mismatch. */
  readonly sha256: string;
  readonly sizeBytes: number;
  /** Binary filename inside the release directory. */
  readonly file: string;
  readonly builtAt: string;
}

/**
 * What one host reports. Small and machine-neutral on purpose: this is the
 * ground floor every managed host can answer.
 */
export interface HostReport {
  readonly agentVersion: string;
  readonly hostname: string;
  readonly os: string;
  readonly arch: string;
  /** The host's uptime. Survives an agent restart, so it cannot detect one. */
  readonly uptimeSeconds: number;
  /**
   * The agent process's own uptime, and the only thing that makes a restart
   * observable. The agent dies executing `restart` and can never acknowledge it,
   * so the panel completes the command when this comes back younger than the
   * time since the command was delivered.
   */
  readonly agentUptimeSeconds: number;
  readonly load1: number;
  readonly memTotalBytes: number;
  readonly memFreeBytes: number;
  /**
   * The agent process's own resident memory (RSS) - the honest answer to "what
   * is the agent using", as against the host totals above, which describe the
   * whole machine and dwarf it.
   */
  readonly agentMemBytes: number;
  /**
   * The agent process's CPU use since the last report, as a percent of one core.
   * Null on the first report, when there is no earlier sample to difference
   * against - a rate needs two points, and the first is only the baseline.
   */
  readonly agentCpuPercent: number | null;
  readonly collectedAt: string;
}

/** Identity claimed at enrolment. Everything here is advisory until verified. */
export interface EnrolRequest {
  readonly hostname: string;
  readonly os: string;
  readonly arch: string;
  readonly agentVersion: string;
  /**
   * A value stable across reinstalls of the same host, so re-enrolling replaces
   * an identity instead of forking one. `/etc/machine-id` where it exists.
   */
  readonly machineId: string;
}

/** The identity an agent persists and presents from then on. */
export interface EnrolResponse {
  readonly agentId: string;
  /** Shown exactly once. The panel keeps only a hash. */
  readonly agentToken: string;
}

/** Everything an operator can ask of an agent. */
export const AGENT_COMMANDS = [
  'report',
  'update',
  'restart',
  'discover',
  'deploy',
] as const;

export type AgentCommandName = (typeof AGENT_COMMANDS)[number];

/**
 * ```
 * queued -> delivered -> completed | failed
 *       \-> expired
 * ```
 * There is no `acknowledged`: an agent that has collected a command runs it in
 * the same tick and reports the outcome on its next call, so a separate ack
 * would be a state nothing is ever observed in.
 */
export const COMMAND_STATES = [
  'queued',
  'delivered',
  'completed',
  'failed',
  'expired',
] as const;

export type CommandState = (typeof COMMAND_STATES)[number];

/** Terminal states. A command in one of these is never delivered again. */
export const SETTLED_STATES = ['completed', 'failed', 'expired'] as const;

/**
 * The credential for one delegated install: one target, one purpose, minutes of
 * life. The agent writes it to a `0600` temp file, uses it, and deletes it - it
 * never lands in the config the service reads.
 *
 * This is the interim shape. `docs/architecture.md` describes where it goes: an
 * operator supplies it at approval time rather than the panel holding a standing
 * key, which is why it travels in the job rather than living on either side.
 */
export interface DeployCredential {
  readonly kind: 'password' | 'privateKey';
  readonly username: string;
  readonly value: string;
  readonly port: number;
}

/** The payload of a `deploy` command: install the agent onto a neighbour. */
export interface DeployPayload {
  readonly target: string;
  readonly credential: DeployCredential;
  /** What the new agent enrols with. Single use, and the panel expires it. */
  readonly enrolmentToken: string;
  /** The address the *target* can reach the panel on, which the panel cannot infer. */
  readonly panelUrl: string;
  /** After this the agent must not act on the job even if it collects it late. */
  readonly expiresAt: string;
}

/** A subnet sweep: report what answers, decide nothing. */
export interface DiscoverPayload {
  /** CIDR to sweep. Absent means the agent's own /24. */
  readonly cidr?: string | undefined;
  /** TCP ports that count as an answer. */
  readonly ports?: readonly number[] | undefined;
}

/** One collected intent, as the agent receives it. */
export interface CommandEnvelope {
  readonly id: string;
  readonly command: AgentCommandName;
  readonly payload: DeployPayload | DiscoverPayload | null;
}

/** The answer to a report: the cadence to keep, and anything queued. */
export interface ReportResponse {
  readonly ok: true;
  readonly agentId: string;
  /** The panel is authoritative about cadence, so a fleet can be slowed centrally. */
  readonly reportIntervalMs: number;
  readonly commands: readonly CommandEnvelope[];
  /**
   * Whether the panel currently permits self-propagation, fleet-wide.
   *
   * The kill switch, and it is one of two keys: an agent spreads only when it is
   * locally opted in (`AGENT_PROPAGATE`) **and** this is true. Delivered on every
   * report rather than stored, so an operator pausing it in the console stops the
   * fleet within one interval without touching a host. Defaults to paused, so
   * propagation is never on by the panel's silence alone.
   */
  readonly propagationAllowed: boolean;
}

/** What the agent sends back once a command has actually run. */
export interface CommandOutcome {
  readonly id: string;
  readonly ok: boolean;
  /** One line, for the console. Truncated rather than rejected if longer. */
  readonly detail?: string | undefined;
}

/** A host that answered a sweep. Reported, never acted on. */
export interface DiscoveredHost {
  readonly address: string;
  readonly ports: readonly number[];
  readonly hostname?: string | undefined;
}

/**
 * The lifecycle moments an agent reports so an operator can see a host come and
 * go, not only infer it from a gap in reports.
 *
 * `startup` is sent once the agent is up and enrolled; `exit` is best-effort on a
 * clean stop (a `SIGTERM` from `systemctl stop`) - a host that loses power or is
 * `SIGKILL`ed cannot send one, which is itself the distinction between a graceful
 * stop and a crash the console can then draw.
 */
export const AGENT_EVENT_KINDS = ['startup', 'exit'] as const;
export type AgentEventKind = (typeof AGENT_EVENT_KINDS)[number];

/** One lifecycle event, as the agent reports it. */
export interface AgentEventReport {
  readonly kind: AgentEventKind;
  /** One line for the console. */
  readonly message: string;
  /** When it happened on the host. */
  readonly at: string;
}

/**
 * One point in an agent's metric history.
 *
 * The panel keeps a bounded time series of these per agent - the last report is
 * a snapshot, and a snapshot cannot show a leak building or a load spike. The
 * numbers are the agent's own (memory, CPU), plus host load for context.
 */
export interface AgentMetricPoint {
  /** When the sample was collected on the host. */
  readonly at: string;
  /** The agent process's resident memory (RSS) at that point. */
  readonly memBytes: number;
  /** The agent process's CPU, percent of one core. Null when it had no baseline. */
  readonly cpuPercent: number | null;
  /** The host's 1-minute load, for context around the agent's own numbers. */
  readonly load1: number;
}

/** A lifecycle event, as the console sees it. */
export interface AgentEventView {
  readonly id: string;
  readonly agentId: string;
  readonly kind: AgentEventKind;
  readonly message: string;
  /** When it happened on the host, as the agent reported it. */
  readonly at: string;
  /** When the panel recorded it - the two differ if the agent was offline. */
  readonly receivedAt: string;
}

// --- What the console is shown -----------------------------------------------
// The panel maps its rows to these before serving them. They are not the storage
// shape: `tokenHash` never leaves the panel, and `connected` is not a column at
// all - it is derived from `lastSeenAt` on every read, because the panel cannot
// dial an agent to ask, only notice when one last arrived.

/** A managed host, as the console sees it. */
export interface AgentView {
  readonly id: string;
  readonly hostname: string;
  readonly agentVersion: string;
  readonly os: string;
  readonly arch: string;
  readonly enrolledAt: string;
  readonly lastSeenAt: string;
  readonly lastIp: string | null;
  /** The host's uptime. See `agentUptimeSeconds` for the agent process's own. */
  readonly uptimeSeconds: number;
  /** The agent process's own uptime, distinct from the host it runs on. */
  readonly agentUptimeSeconds: number;
  /**
   * The agent process's own resident memory (RSS), not the host's - what the
   * console shows, because an operator watching a fleet of agents wants to know
   * what the agent costs, not that the box it sits on has 63 GB. Null until the
   * first report.
   */
  readonly agentMemBytes: number | null;
  /** The agent process's CPU since the last report, percent of one core. Null until two reports. */
  readonly agentCpuPercent: number | null;
  readonly reportedAt: string | null;
  /** Derived from `lastSeenAt`, never stored. */
  readonly connected: boolean;
  /** True when the panel has a newer release than this agent is running. */
  readonly updateAvailable: boolean;
  /**
   * The agent that deployed this one, when it arrived via a deployment grant.
   * Null for seed agents and any host enrolled by hand with the shared token.
   * Together with the discovery record's `foundBy`, this lets the console draw
   * a "who installed whom" lineage tree across the fleet.
   */
  readonly installedBy: string | null;
}

/** A queued intent and where it got to, never a result. */
export interface CommandView {
  readonly id: string;
  readonly agentId: string;
  readonly command: AgentCommandName;
  readonly state: CommandState;
  readonly queuedAt: string;
  readonly expiresAt: string;
  readonly deliveredAt: string | null;
  readonly settledAt: string | null;
  readonly detail: string | null;
  readonly issuedBy: string | null;
}

/** A host on a managed subnet that is not managed yet. */
export interface DiscoveryView {
  readonly address: string;
  readonly hostname: string | null;
  readonly ports: readonly number[];
  readonly foundBy: string;
  readonly lastSeenAt: string;
  readonly enrolledAgentId: string | null;
}

/** Fleet-wide switches an operator controls live from the console. */
export interface FleetSettings {
  /** The panel's half of the propagation kill switch. See `ReportResponse`. */
  readonly propagationAllowed: boolean;
}
