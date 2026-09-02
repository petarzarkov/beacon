import { Logger } from '@dunx/core';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { hostname } from 'node:os';
import { homedir } from 'node:os';
import { dirname } from 'node:path';
import { AgentConfigService, SERVICE_NAME } from './settings.js';

/** What the panel issued at enrolment, and what every later call presents. */
export interface Identity {
  readonly agentId: string;
  readonly agentToken: string;
  /** The panel it enrolled with, so pointing an agent at a new one re-enrols it. */
  readonly panelUrl: string;
  readonly enrolledAt: string;
}

/**
 * Where the service normally keeps it. `/var/lib` rather than `/etc`, because
 * this is state the machine generated, not configuration a human wrote.
 */
const SERVICE_STATE = `/var/lib/${SERVICE_NAME}/identity.json`;

/**
 * The identity issued at enrolment, and the fact that it has to survive a
 * restart.
 *
 * Without persistence every restart would enrol again. The panel keys on
 * `machineId` so it would not create duplicate rows, but it would mint a new
 * token each time and the fleet-wide enrolment token would become a permanent
 * runtime requirement rather than a one-off - which is exactly the property that
 * makes a per-agent token worth having.
 */
export class IdentityStore {
  constructor(
    private readonly config: AgentConfigService,
    private readonly logger: Logger,
  ) {}

  /**
   * In order of preference, and the fallback is not a convenience.
   *
   * `install` runs as root and hands `/var/lib/beacon-agent` to the service
   * user, so the first path is the one a real deployment uses. The second is
   * what makes `bun run dev:agent` work as an ordinary user - without it the
   * only way to run an agent outside a systemd unit would be as root.
   */
  #candidates(): readonly string[] {
    const configured = this.config.get('stateFile');
    if (configured !== undefined) return [configured];
    return [
      SERVICE_STATE,
      `${homedir()}/.local/state/${SERVICE_NAME}/identity.json`,
    ];
  }

  load(): Identity | null {
    for (const path of this.#candidates()) {
      if (!existsSync(path)) continue;
      try {
        const identity = JSON.parse(readFileSync(path, 'utf8')) as Identity;
        // A file that parses but is not an identity is worse than none: it would
        // be presented as a token and rejected forever. Re-enrolling is right.
        if (
          typeof identity.agentId === 'string' &&
          typeof identity.agentToken === 'string'
        ) {
          return identity;
        }
        this.logger.warn('identity file is not an identity, re-enrolling', {
          path,
        });
      } catch {
        // Unreadable is treated exactly like absent. It is mode 0600 owned by
        // the service user, so any other user gets EACCES here, and that must
        // not be fatal for `version` or `probe`.
      }
    }
    return null;
  }

  save(identity: Identity): void {
    let lastError: unknown;
    for (const path of this.#candidates()) {
      try {
        mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
        writeFileSync(path, `${JSON.stringify(identity, null, 2)}\n`);
        // It is a working fleet credential; never world-readable.
        chmodSync(path, 0o600);
        this.logger.info('identity stored', {
          path,
          agentId: identity.agentId,
        });
        return;
      } catch (error) {
        lastError = error;
      }
    }
    throw new Error(
      `Could not persist the agent identity to any of ${this.#candidates().join(', ')}: ${
        lastError instanceof Error ? lastError.message : String(lastError)
      }`,
    );
  }

  /**
   * A value stable across reinstalls, so re-enrolling replaces an identity
   * rather than forking one.
   *
   * `/etc/machine-id` is the right answer where it exists: it is generated once
   * when the system is first installed and does not move when the host is
   * renamed or its address changes. The hostname fallback is weaker - two hosts
   * that share a name would collide onto one row - but it is better than a
   * random value, which would make every reinstall a new machine forever.
   *
   * `AGENT_MACHINE_ID` overrides both, for hosts where the file is not unique:
   * containers from one image share it, and so does every agent in the
   * end-to-end suite.
   */
  machineId(): string {
    const configured = this.config.get('machineId');
    if (configured !== undefined) return configured;

    for (const path of ['/etc/machine-id', '/var/lib/dbus/machine-id']) {
      try {
        const id = readFileSync(path, 'utf8').trim();
        if (id !== '') return id;
      } catch {
        // Not this one.
      }
    }
    this.logger.warn('no /etc/machine-id, falling back to the hostname');
    return `hostname:${hostname()}`;
  }
}
