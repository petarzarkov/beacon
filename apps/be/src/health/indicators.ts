import {
  DatabaseIndicator,
  HealthIndicator,
  MemoryIndicator,
  MemoryOptions,
  type ProbeResult,
} from '@dunx/http';
import type { DbConnection } from '@dunx/infra/db';
import { AgentsService } from '../agents/agents.service.js';
import { ReleasesService } from '../agents/releases.service.js';

/**
 * Whether the fleet can actually be served.
 *
 * `DatabaseIndicator` asks whether the connection answers; this asks whether the
 * panel can do the one job an agent depends on it for. An agent that cannot pull
 * a release is stuck on whatever version it has, silently, forever - so a panel
 * with no published binary is degraded rather than healthy, even though every
 * route still answers.
 *
 * Not critical: a panel with no release still ingests reports and still queues
 * commands, and refusing readiness would take the whole fleet's visibility away
 * to report a problem that only affects updates.
 */
export class ReleaseIndicator extends HealthIndicator {
  readonly name = 'agent-release';
  override readonly critical = false;

  constructor(private readonly releases: ReleasesService) {
    super();
  }

  check(): ProbeResult {
    const manifest = this.releases.manifest();
    return manifest === null
      ? {
          state: 'down',
          detail: 'no agent release published - run `bun run build:agent`',
        }
      : {
          state: 'up',
          detail: `serving ${manifest.version} (${(manifest.sizeBytes / 1024 / 1024).toFixed(1)} MB)`,
        };
  }
}

/**
 * How much of the fleet is actually reporting.
 *
 * Reported, never failed on. Every agent going quiet at once is far more likely
 * to be a network event than a panel fault, and a readiness probe that fails
 * would restart the one process that still knows what the fleet looked like.
 */
export class FleetIndicator extends HealthIndicator {
  readonly name = 'fleet';
  override readonly critical = false;

  constructor(private readonly agents: AgentsService) {
    super();
  }

  check(): ProbeResult {
    const all = this.agents.list();
    const connected = all.filter((agent) => agent.connected).length;
    return {
      state: 'up',
      detail: `${connected}/${all.length} agents reporting`,
    };
  }
}

export interface AppIndicatorsInit {
  readonly db: DbConnection;
  readonly agents: AgentsService;
  readonly releases: ReleasesService;
}

/** One declaration of what this service probes, read by `HealthModule`. */
export class AppIndicators {
  readonly readiness: readonly HealthIndicator[];
  readonly liveness: readonly HealthIndicator[];

  constructor(init: AppIndicatorsInit) {
    this.readiness = [
      new DatabaseIndicator(init.db),
      new ReleaseIndicator(init.releases),
      new FleetIndicator(init.agents),
    ];
    // A ceiling belongs on liveness, where the orchestrator restarts rather
    // than routes around.
    this.liveness = [
      new MemoryIndicator(
        new MemoryOptions({ maxRssBytes: 1024 * 1024 * 1024 }),
      ),
    ];
  }
}
