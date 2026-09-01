import { ConfigService, type ConfigSource, LogLevel } from '@dunx/core';
import { z } from 'zod';
import pkg from '../../package.json';

/**
 * Single source of truth for the version, inlined by the bundler at compile
 * time. Bun resolves `process.env` at runtime inside a compiled binary and
 * ignores `--define` entirely, so a JSON import is the only stamping that
 * survives `bun build --compile`.
 */
export const AGENT_VERSION: string = pkg.version;

export const SERVICE_NAME = 'dunxon-agent';

/** Mode `0600`, because it holds the enrolment token. Written by `install`. */
export const CONFIG_PATH = `/etc/${SERVICE_NAME}/agent.conf`;

/** Where `install` puts the binary, and therefore what an update replaces. */
export const INSTALL_PATH = `/usr/local/bin/${SERVICE_NAME}`;

export const UNIT_PATH = `/etc/systemd/system/${SERVICE_NAME}.service`;
export const UPDATE_SERVICE_NAME = `${SERVICE_NAME}-update.service`;
export const UPDATE_TIMER_NAME = `${SERVICE_NAME}-update.timer`;
export const UPDATE_SERVICE_PATH = `/etc/systemd/system/${UPDATE_SERVICE_NAME}`;
export const UPDATE_TIMER_PATH = `/etc/systemd/system/${UPDATE_TIMER_NAME}`;

/** The unix user the service runs as. Not root - see `install.service.ts`. */
export const DEFAULT_RUN_USER = 'dunxon';

const schema = z.object({
  /**
   * All diagnostics go to stderr (see `agent.module.ts`), so stdout is left for
   * a command's own output - `probe`, `discover` and `propagate --dry-run` each
   * print JSON that must parse. This only sets how much of it is emitted.
   */
  LOG_LEVEL: z.enum(LogLevel).default(LogLevel.INFO),
  PANEL_URL: z.url().optional(),
  /**
   * The fleet-wide enrolment token, used exactly once. After enrolment the agent
   * holds its own token instead and this is no longer consulted, which is why
   * losing it does not strand a running agent.
   */
  AGENT_TOKEN: z.string().min(1).optional(),
  /** How often to report when the panel has not said otherwise. */
  REPORT_INTERVAL_MS: z.coerce.number().int().min(1000).default(30_000),
  /** How often to ask whether a newer release is published. */
  UPDATE_INTERVAL_MS: z.coerce
    .number()
    .int()
    .min(60_000)
    .default(6 * 3600_000),
  /**
   * Where the identity issued at enrolment is kept. Unset means the default
   * chain in `identity.ts`, which is what lets the agent run as a service and
   * also run from a checkout with no root.
   */
  AGENT_STATE_FILE: z.string().optional(),
  /** Per-request budget when talking to the panel. */
  PANEL_TIMEOUT_MS: z.coerce.number().int().min(1000).default(20_000),
  /**
   * Overrides the identity read from `/etc/machine-id`.
   *
   * Needed wherever that value is not unique per agent, which is more common
   * than it sounds: containers built from one image share it, and so does every
   * agent in the end-to-end suite, which runs a whole fleet on one host. Without
   * an override they would all enrol onto a single row.
   */
  AGENT_MACHINE_ID: z.string().min(1).optional(),

  /**
   * The binary an update replaces, and therefore where `install` puts it.
   *
   * A real host never sets this - the default is the only sane place for it - but
   * it has to be overridable, because the self-update swap is otherwise
   * untestable: it renames a file over `/usr/local/bin/dunxon-agent`, which no
   * test can own. The end-to-end suite points it at a temp path and drives the
   * real swap against that. See `update.service.ts`.
   */
  AGENT_INSTALL_PATH: z.string().min(1).default(INSTALL_PATH),
  /**
   * Run in place of `systemctl restart` after a successful self-update.
   *
   * Same reason as `AGENT_INSTALL_PATH`: a machine without systemd - a CI runner,
   * the e2e suite - cannot restart the service the production way, so the restart
   * step would either fail or be skipped, and an update that never proves it
   * restarts is not an update that has been tested. The suite sets this to a
   * script that records the restart, so the whole path runs. Unset in production,
   * where systemd owns the lifecycle.
   */
  AGENT_RESTART_COMMAND: z.string().min(1).optional(),
  /**
   * Run in place of `sudo systemctl start dunxon-agent-update.service` when an
   * unprivileged service collects a queued `update`.
   *
   * In production the service cannot swap its own binary - that is the whole
   * point of the privilege split - so it asks the root update unit to. That unit
   * runs `dunxon-agent update`, i.e. the same swap this file performs. With no
   * systemd to ask, the operator-driven `update` flow is untestable; the suite
   * points this at a script that runs the real swap, so the queued path is
   * proven end to end rather than only the swap in isolation. Unset in production.
   */
  AGENT_UPDATE_TRIGGER_COMMAND: z.string().min(1).optional(),

  /**
   * Self-propagation: sweep the subnet and install the agent onto neighbours,
   * with no panel in the loop. **Off by default, and deliberately so.**
   *
   * This is the one thing in the system that holds a standing credential - the
   * SSH key or password below, which works across the fleet - so a stolen agent
   * becomes a way into its neighbours. That is exactly what the panel-brokered
   * `deploy` path avoids by having the operator supply a credential per install.
   * Turning this on trades that safety for a fleet that assembles itself from one
   * seeded host, which is the right trade only for a homogeneous fleet an
   * operator fully owns. See `docs/architecture.md`.
   */
  AGENT_PROPAGATE: z.stringbool().default(false),
  /** The login to install as on a neighbour. */
  AGENT_PROPAGATE_USER: z.string().min(1).optional(),
  /** A private key (inline PEM or a path), used to reach neighbours. */
  AGENT_PROPAGATE_KEY: z.string().min(1).optional(),
  /** A password, the alternative to a key. Needs `sshpass` on this host. */
  AGENT_PROPAGATE_PASSWORD: z.string().min(1).optional(),
  AGENT_PROPAGATE_PORT: z.coerce.number().int().min(1).max(65535).default(22),
  /** How often to sweep and spread. Slow: this is background colonisation. */
  AGENT_PROPAGATE_INTERVAL_MS: z.coerce
    .number()
    .int()
    .min(10_000)
    .default(300_000),
  /** The URL a *neighbour* can reach the panel on, which this host cannot infer for it. */
  AGENT_PROPAGATE_PANEL_URL: z.url().optional(),
  /**
   * A hard cap on how many new installs one pass may start.
   *
   * Without a limit, a single pass across a large flat /16 could attempt
   * thousands of SSH connections in one go — too many to monitor and too easy to
   * confuse with a scan. The default (50) lets a typical /24 finish in one pass
   * while still being obviously bounded. Raise it deliberately if sweeping a
   * larger segment; the /24 CIDR limit in `discover` is the companion blast-radius
   * guard for the sweep itself.
   */
  AGENT_PROPAGATE_MAX_PER_PASS: z.coerce.number().int().min(1).default(50),
});

export interface AgentConfig {
  readonly version: string;
  readonly logLevel: LogLevel;
  readonly panelUrl: string | undefined;
  readonly token: string | undefined;
  readonly reportIntervalMs: number;
  readonly updateIntervalMs: number;
  readonly stateFile: string | undefined;
  readonly panelTimeoutMs: number;
  readonly machineId: string | undefined;
  /** The binary a self-update replaces. Default `/usr/local/bin/dunxon-agent`. */
  readonly installPath: string;
  /** Overrides `systemctl restart` after an update. Unset in production. */
  readonly restartCommand: string | undefined;
  /** Overrides the `sudo systemctl start` update trigger. Unset in production. */
  readonly updateTriggerCommand: string | undefined;
  readonly propagate: {
    readonly enabled: boolean;
    readonly user: string | undefined;
    readonly key: string | undefined;
    readonly password: string | undefined;
    readonly port: number;
    readonly intervalMs: number;
    readonly panelUrl: string | undefined;
    /** Maximum new installs per pass. Prevents a single sweep from flooding a large segment. */
    readonly maxPerPass: number;
  };
}

/**
 * One name for the typed config everywhere, for the reason the panel's own
 * subclass exists: a factory's `inject: [...]` carries no type argument, and a
 * class is both a precise token and a usable annotation.
 */
export class AgentConfigService extends ConfigService<AgentConfig> {
  /** Throws rather than reporting nowhere, which is the failure worth being loud about. */
  requirePanelUrl(): string {
    const panelUrl = this.get('panelUrl');
    if (panelUrl === undefined) {
      throw new Error(
        `No panel URL. Pass --panel-url, set PANEL_URL, or run \`install\` to write ${CONFIG_PATH}.`,
      );
    }
    return panelUrl.replace(/\/+$/, '');
  }

  /**
   * The enrolment token, needed only until the agent has an identity of its own.
   * Separate from `requirePanelUrl` because an enrolled agent has a panel URL and
   * no use for this one, and demanding both would strand it if the shared token
   * were rotated.
   */
  requireEnrolmentToken(): string {
    const token = this.get('token');
    if (token === undefined) {
      throw new Error(
        `No enrolment token. Pass --token, set AGENT_TOKEN, or run \`install\` to write ${CONFIG_PATH}.`,
      );
    }
    return token;
  }
}

export const validate = (env: ConfigSource): AgentConfig => {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n - ');
    throw new Error(`Agent configuration is invalid:\n - ${issues}`);
  }
  const v = parsed.data;
  return {
    version: AGENT_VERSION,
    logLevel: v.LOG_LEVEL,
    panelUrl: v.PANEL_URL,
    token: v.AGENT_TOKEN,
    reportIntervalMs: v.REPORT_INTERVAL_MS,
    updateIntervalMs: v.UPDATE_INTERVAL_MS,
    stateFile: v.AGENT_STATE_FILE,
    panelTimeoutMs: v.PANEL_TIMEOUT_MS,
    machineId: v.AGENT_MACHINE_ID,
    installPath: v.AGENT_INSTALL_PATH,
    restartCommand: v.AGENT_RESTART_COMMAND,
    updateTriggerCommand: v.AGENT_UPDATE_TRIGGER_COMMAND,
    propagate: {
      enabled: v.AGENT_PROPAGATE,
      user: v.AGENT_PROPAGATE_USER,
      key: v.AGENT_PROPAGATE_KEY,
      password: v.AGENT_PROPAGATE_PASSWORD,
      port: v.AGENT_PROPAGATE_PORT,
      intervalMs: v.AGENT_PROPAGATE_INTERVAL_MS,
      panelUrl: v.AGENT_PROPAGATE_PANEL_URL,
      maxPerPass: v.AGENT_PROPAGATE_MAX_PER_PASS,
    },
  };
};
