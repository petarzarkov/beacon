import { Auth } from '@dunx/auth';
import { ConfigModule, Module } from '@dunx/core';
import { LoggerModule } from '@dunx/infra/logger';
import { AppConfigService, validate } from './config.js';
import { AgentsModule } from './agents/agents.module.js';
import { AccountsModule } from './auth/auth.module.js';
import { ConsoleModule } from './console/console.module.js';
import { DatabaseModule } from './database/database.module.js';
import { ProbesModule } from './health/health.module.js';
import { HttpModule } from './http/http.module.js';

/**
 * Import order is construction order, and shutdown runs in reverse - so config and
 * the logger are built first and torn down last, and anything a feature depends on
 * outlives it.
 *
 * `AgentsModule` is the app; everything above it in this list is what it needs to
 * exist. `ProbesModule` comes after it because its indicators inject the fleet.
 */
@Module({
  imports: [
    ConfigModule.forRoot({ validate, as: AppConfigService }),
    // The level comes from the validated config, which is the one thing a
    // zero-argument `forRoot` function cannot reach.
    LoggerModule.forRootAsync(
      {
        useFactory: (config: AppConfigService) => ({
          name: config.get('appName'),
          level: config.get('log').level,
        }),
        inject: [AppConfigService] as const,
      },
      { captureGlobalErrors: true },
    ),
    HttpModule,
    DatabaseModule,
    AccountsModule,
    AgentsModule,
    ProbesModule,
    ConsoleModule,
  ],
  // Better Auth serves its own routes, so the document is the only place they
  // appear - and `betterAuthDocument` needs the instance.
  exports: [Auth],
})
export class AppModule {}
