import { ConfigService, type ConfigSource, LogLevel } from '@dunx/core';
import { z } from 'zod';

/**
 * One validation function, which is the whole `ConfigModule` contract. dunx does
 * not pick the library - this is zod because the routes already use it, and a
 * hand-written function that throws would work identically.
 *
 * `.default()` is where a value comes from when the variable is unset, so a clean
 * checkout boots with no `.env` at all. Bun loads `.env` and `.env.local` itself,
 * so there is nothing here that reads a file.
 */
/**
 * The stand-in secret a clean checkout boots with. Fine for local use, and a
 * boot-time error anywhere that looks like a real deployment - see the guard in
 * `validate`. Named so the schema default and that guard cannot drift apart.
 */
const DEV_AUTH_SECRET = 'dunx-development-secret-not-for-production';

/** A panel reachable only from this machine - the one place the dev secret is safe. */
const isLocalUrl = (url: string): boolean =>
  /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?\/?$/i.test(url);

const envSchema = z.object({
  PORT: z.coerce.number().int().min(0).max(65535).default(3000),
  LOG_LEVEL: z.enum(LogLevel).default(LogLevel.INFO),
  /** Unset means console only. Set it to also append JSON to a rotating file. */
  LOG_FILE: z.string().optional(),
  /** Both cost a `req.clone().text()` on the hot path, so off in production. */
  LOG_REQUEST_BODY: z.stringbool().default(false),
  LOG_RESPONSE_BODY: z.stringbool().default(false),
  /** The console in development. In production it is served from this same origin. */
  CORS_ORIGIN: z.string().default('http://localhost:5173'),
  /**
   * The panel's own public origin — where operators reach the console and where
   * agents dial in. `https://panel.example.com` in production.
   *
   * Load bearing once the panel is public: Better Auth signs cookies against it
   * and refuses a sign-in from an untrusted origin, so a panel served at a real
   * domain but left on `localhost` here rejects every browser sign-in. Unset
   * means `http://localhost:PORT`, which is right only for local use.
   */
  APP_URL: z.string().optional(),
  /**
   * Whether `x-forwarded-for` is believed. Off unless a trusted proxy is in
   * front: with nothing stripping the header, any caller picks its own
   * address, which fakes both rate limiting and the logged client address.
   *
   * It also decides more here than it does in most apps. A deployment grant is
   * bound to the address it was minted for, so behind a proxy with this off,
   * every agent appears to come from the proxy and no grant can be honoured.
   */
  TRUST_PROXY: z.stringbool().default(false),
  /**
   * A file, not `:memory:`. The fleet is the state - an agent's identity, its
   * token hash and what it has been asked to do - and losing it on restart would
   * mean every host re-enrolling as a stranger. The tests pass `:memory:`.
   */
  DATABASE_FILE: z.string().default('./data/panel.sqlite'),
  /** better-auth signs session cookies with this, and the panel signs deployment grants with it. */
  AUTH_SECRET: z.string().min(32).default(DEV_AUTH_SECRET),
  /** A `@Cron` that names no zone of its own runs in this one. */
  SCHEDULE_TZ: z.string().default('UTC'),

  /**
   * The fleet-wide credential a host presents once to become an agent. Empty
   * disables manual enrolment entirely, which is the right default: a panel that
   * shipped with a working enrolment token would accept any host that found it.
   *
   *   openssl rand -hex 32
   */
  AGENT_ENROLMENT_TOKEN: z.string().default(''),
  /** Where `bun run build:agent` publishes. Mirrors AGENT_RELEASE_DIR there. */
  AGENT_RELEASE_DIR: z.string().default('./data/agent'),
  /** The cadence the panel hands agents, so a fleet can be slowed centrally. */
  AGENT_REPORT_INTERVAL_MS: z.coerce.number().int().min(1000).default(30_000),
  /**
   * Silence longer than this and the console stops calling an agent connected.
   * Defaults to three missed reports rather than one: a single dropped request
   * on a busy host is not an outage, and flapping rows train an operator to
   * ignore the column.
   */
  AGENT_OFFLINE_AFTER_MS: z.coerce.number().int().min(1000).optional(),
  /**
   * How long a queued command stays deliverable. An agent that has been off for
   * a week must not come back to a restart nobody remembers asking for.
   */
  AGENT_COMMAND_TTL_MS: z.coerce.number().int().min(10_000).default(3_600_000),
  /**
   * The initial state of the fleet-wide propagation kill switch, before an
   * operator touches it. **Paused by default**, so autonomous self-spread is
   * never on by the panel's silence alone - it takes both a host opting in and
   * the panel being armed. Once set live in the console the stored value wins;
   * this only seeds the first boot.
   */
  AGENT_PROPAGATION_ALLOWED: z.stringbool().default(false),
});

export interface AppConfig {
  readonly port: number;
  readonly appName: string;
  readonly log: {
    readonly level: LogLevel;
    readonly file: string | undefined;
    readonly requestBody: boolean;
    readonly responseBody: boolean;
  };
  readonly corsOrigin: string;
  /** The panel's public origin. Falls back to `http://localhost:PORT`. */
  readonly appUrl: string;
  readonly trustProxy: boolean;
  readonly database: { readonly file: string };
  readonly auth: { readonly secret: string };
  readonly schedule: { readonly tz: string };
  readonly agents: {
    readonly enrolmentToken: string;
    readonly releaseDir: string;
    readonly reportIntervalMs: number;
    readonly offlineAfterMs: number;
    readonly commandTtlMs: number;
    readonly propagationAllowedDefault: boolean;
  };
}

/**
 * One name for the typed config everywhere. A subclass rather than
 * `ConfigService<AppConfig>` at each site because a factory's `inject: [...]`
 * carries no type argument - the class does, and it is a real runtime value, so it
 * is both a precise token and a usable constructor annotation.
 */
export class AppConfigService extends ConfigService<AppConfig> {}

/** Flat variables in, a shaped object out. Nothing downstream reads `Bun.env`. */
export const validate = (env: ConfigSource): AppConfig => {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n - ');
    throw new Error(`Configuration is invalid:\n - ${issues}`);
  }
  const value = parsed.data;

  const appUrl = value.APP_URL ?? `http://localhost:${value.PORT}`;

  // The dev secret is fine locally and a refusal anywhere that looks live. A
  // real APP_URL or a trusted proxy in front is a panel operators sign in to and
  // agents dial - and the same secret signs both session cookies and the
  // deployment grants that admit a host, so shipping the published default would
  // mean anyone could forge either. Caught here, at boot, not at the first login.
  if (
    value.AUTH_SECRET === DEV_AUTH_SECRET &&
    (value.TRUST_PROXY || !isLocalUrl(appUrl))
  ) {
    throw new Error(
      'Configuration is invalid:\n - AUTH_SECRET: still the development default, ' +
        'but this panel is configured for a real deployment ' +
        `(${value.TRUST_PROXY ? 'TRUST_PROXY is on' : `APP_URL is ${appUrl}`}). ` +
        'Set AUTH_SECRET to a strong secret: openssl rand -hex 32',
    );
  }

  return {
    port: value.PORT,
    appName: 'dunxon-be',
    log: {
      level: value.LOG_LEVEL,
      file: value.LOG_FILE,
      requestBody: value.LOG_REQUEST_BODY,
      responseBody: value.LOG_RESPONSE_BODY,
    },
    corsOrigin: value.CORS_ORIGIN,
    // The public origin, or a local default derived from the port so a clean
    // checkout still boots and signs in.
    appUrl,
    trustProxy: value.TRUST_PROXY,
    database: { file: value.DATABASE_FILE },
    auth: { secret: value.AUTH_SECRET },
    schedule: { tz: value.SCHEDULE_TZ },
    agents: {
      enrolmentToken: value.AGENT_ENROLMENT_TOKEN,
      releaseDir: value.AGENT_RELEASE_DIR,
      reportIntervalMs: value.AGENT_REPORT_INTERVAL_MS,
      // Derived rather than defaulted, so raising the interval does not silently
      // leave the console calling agents offline between two healthy reports.
      offlineAfterMs:
        value.AGENT_OFFLINE_AFTER_MS ?? value.AGENT_REPORT_INTERVAL_MS * 3,
      commandTtlMs: value.AGENT_COMMAND_TTL_MS,
      propagationAllowedDefault: value.AGENT_PROPAGATION_ALLOWED,
    },
  };
};
