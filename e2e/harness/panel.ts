import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HttpApp } from '@dunx/http';
import { createApp } from '@be/main.js';
import { createOperator } from '@be/auth/create-operator.js';
import { mintGrant } from '@be/agents/enrolment.js';
import { MANIFEST_FILE, type ReleaseManifest } from '@beacon/contract';
import { Operator } from './operator.js';

export interface PanelOptions {
  /** The fleet-wide credential. Empty disables manual enrolment, which is a case worth testing. */
  readonly enrolmentToken?: string;
  /** How often the panel tells agents to report. Small, so a suite is not a minute of waiting. */
  readonly reportIntervalMs?: number;
  /** Silence longer than this and an agent stops counting as connected. */
  readonly offlineAfterMs?: number;
  /** How long a queued command stays deliverable. */
  readonly commandTtlMs?: number;
  /** Publish a fake release, so update paths can be exercised without an 80 MB build. */
  readonly release?:
    | { readonly version: string; readonly body?: string }
    | false;
  /** The initial state of the propagation kill switch. Defaults to paused. */
  readonly propagationAllowed?: boolean;
}

export interface Panel {
  readonly url: string;
  readonly app: HttpApp;
  readonly enrolmentToken: string;
  readonly releaseDir: string;
  /** The published manifest, when `release` was requested. */
  readonly manifest: ReleaseManifest | null;
  /** A signed-in admin console client. */
  operator(): Promise<Operator>;
  /** A signed-in non-admin operator, for testing role-gated routes. */
  plainUser(): Promise<Operator>;
  /**
   * Mint a signed deployment grant for the given address.
   *
   * Useful in e2e tests that need to enrol an agent via a grant without going
   * through the full SSH-install flow. The grant is scoped to `address` and
   * valid for `ttlMs` (default 60 s). In test environments without TRUST_PROXY,
   * the panel sees no source IP, so the address-match check is skipped and any
   * address works.
   */
  grantFor(address: string, ttlMs?: number): string;
  close(): Promise<void>;
}

const DEFAULTS = {
  enrolmentToken: 'e2e-enrolment-token',
  reportIntervalMs: 1000,
  offlineAfterMs: 3000,
  commandTtlMs: 3_600_000,
} as const;

/**
 * A real panel, in this process, on an ephemeral port.
 *
 * In-process rather than spawned, because `listen(0)` then hands back the port
 * it actually bound - which is what lets a suite run several panels at once
 * without a registry of hard-coded ports that go stale the moment two files run
 * in parallel.
 *
 * The database is `:memory:`, so every panel starts empty and nothing has to be
 * cleaned up between tests. That is also the one place this differs from
 * production, where the default is a file - see `config.ts` for why.
 */
export const startPanel = async (
  options: PanelOptions = {},
): Promise<Panel> => {
  const releaseDir = mkdtempSync(join(tmpdir(), 'beacon-e2e-release-'));
  const manifest = publishRelease(releaseDir, options.release ?? false);

  const enrolmentToken = options.enrolmentToken ?? DEFAULTS.enrolmentToken;
  const env: Record<string, string> = {
    DATABASE_FILE: ':memory:',
    LOG_LEVEL: process.env['E2E_LOG'] ?? 'error',
    AGENT_ENROLMENT_TOKEN: enrolmentToken,
    AGENT_RELEASE_DIR: releaseDir,
    AGENT_REPORT_INTERVAL_MS: String(
      options.reportIntervalMs ?? DEFAULTS.reportIntervalMs,
    ),
    AGENT_OFFLINE_AFTER_MS: String(
      options.offlineAfterMs ?? DEFAULTS.offlineAfterMs,
    ),
    AGENT_COMMAND_TTL_MS: String(options.commandTtlMs ?? DEFAULTS.commandTtlMs),
    AGENT_PROPAGATION_ALLOWED: String(options.propagationAllowed ?? false),
    // Distinct per panel, so a grant minted by one is not honoured by another -
    // which is itself asserted in enrolment.e2e.ts.
    AUTH_SECRET: `e2e-secret-${crypto.randomUUID()}`,
  };
  const authSecret = env['AUTH_SECRET']!;

  // Config is read from the environment when the container is built, so this has
  // to be in place before `createApp` and restored after it - otherwise a second
  // panel in the same file inherits the first one's settings.
  const restore = applyEnv(env);
  let app: HttpApp;
  try {
    app = await createApp();
  } finally {
    restore();
  }

  const url = await app.listen(0);
  const base = url.toString().replace(/\/+$/, '');

  return {
    url: base,
    app,
    enrolmentToken,
    releaseDir,
    manifest,
    async operator(): Promise<Operator> {
      const email = `ops-${crypto.randomUUID()}@example.com`;
      const password = 'e2e-operator-password';
      await createOperator(app, { email, password, name: 'E2E Operator' });
      return Operator.signIn(base, email, password);
    },
    async plainUser(): Promise<Operator> {
      const email = `user-${crypto.randomUUID()}@example.com`;
      const password = 'e2e-operator-password';
      await createOperator(app, { email, password, admin: false });
      return Operator.signIn(base, email, password);
    },
    grantFor(address: string, ttlMs = 60_000): string {
      return mintGrant(authSecret, address, Date.now() + ttlMs);
    },
    async close(): Promise<void> {
      await app.shutdown();
      rmSync(releaseDir, { recursive: true, force: true });
    },
  };
};

/**
 * A release the panel can serve, without building the real binary.
 *
 * The agent verifies a sha256 before installing anything, so the manifest has to
 * describe the bytes exactly - a fake release with a made-up hash would test the
 * refusal path and nothing else.
 */
const publishRelease = (
  dir: string,
  release: PanelOptions['release'],
): ReleaseManifest | null => {
  if (release === false || release === undefined) return null;

  const file = 'beacon-agent';
  const body = release.body ?? `#!/bin/sh\necho ${release.version}\n`;
  const bytes = new TextEncoder().encode(body);
  writeFileSync(join(dir, file), bytes);

  const manifest: ReleaseManifest = {
    version: release.version,
    sha256: new Bun.CryptoHasher('sha256').update(bytes).digest('hex'),
    sizeBytes: bytes.byteLength,
    file,
    builtAt: new Date().toISOString(),
  };
  writeFileSync(
    join(dir, MANIFEST_FILE),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  return manifest;
};

/** Sets each key, handing back a function that puts the previous values back. */
const applyEnv = (env: Record<string, string>): (() => void) => {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(env)) {
    previous.set(key, process.env[key]);
    process.env[key] = value;
  }
  return () => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
};
