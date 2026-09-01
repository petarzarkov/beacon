import { Module, provide } from '@dunx/core';
import { HealthModule } from '@dunx/http';
import { DbConnection } from '@dunx/infra/db';
import { AgentsModule } from '../agents/agents.module.js';
import { AgentsService } from '../agents/agents.service.js';
import { ReleasesService } from '../agents/releases.service.js';
import { DatabaseModule } from '../database/database.module.js';
import { AppIndicators } from './indicators.js';

/**
 * Its own module because `HealthModule.forRootAsync` registers in its own scope,
 * so a factory injecting `AppIndicators` must name where it comes from - and
 * pointing that back at `ProbesModule` would be a cycle.
 */
@Module({
  imports: [DatabaseModule, AgentsModule],
  providers: [
    provide(AppIndicators, {
      useFactory: (
        db: DbConnection,
        agents: AgentsService,
        releases: ReleasesService,
      ) => new AppIndicators({ db, agents, releases }),
      inject: [DbConnection, AgentsService, ReleasesService] as const,
    }),
  ],
  exports: [AppIndicators],
})
export class IndicatorsModule {}

/**
 * Mounts `/api/health/live` and `/api/health/ready`, both `@Public()` and hidden
 * from the document.
 */
@Module({
  imports: [
    IndicatorsModule,
    HealthModule.forRootAsync({
      imports: [IndicatorsModule],
      useFactory: (indicators: AppIndicators) => ({
        readiness: indicators.readiness,
        liveness: indicators.liveness,
        // A real deployment tunes this so a load balancer sees readiness fail
        // before the socket closes.
        drainDelayMs: 250,
      }),
      inject: [AppIndicators] as const,
    }),
  ],
  exports: [AppIndicators],
})
export class ProbesModule {}
