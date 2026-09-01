/**
 * The wire contract between the panel and an agent, and the one definition of it.
 *
 * **This file imports nothing, deliberately.** The agent compiles to a binary and
 * reaches these types through the `@panel/*` alias in its tsconfig; a single
 * import here would drag the panel's container graph into that bundle. Types and
 * string constants only - the zod schemas that validate this on the way in live
 * in `agents.schemas.ts`, panel-side, where zod is already a dependency.
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
