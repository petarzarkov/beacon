import { Auth, AuthContext, AuthModule, SessionGuard } from '@dunx/auth';
import { drizzleDatabase } from '@dunx/auth/drizzle';
import { Module } from '@dunx/core';
import { DbConnection } from '@dunx/infra/db';
import { AppConfigService } from '../config.js';
import { DatabaseModule } from '../database/database.module.js';
import { authOptions } from './auth.options.js';
import { AuthTables } from './auth.tables.js';
import { Audit } from './audit.service.js';
import { ProfileController } from './profile.controller.js';

/** Named for the feature, so `AuthModule` still means `@dunx/auth`'s. */
@Module({
  imports: [
    DatabaseModule,
    // `forRootAsync`: the secret, base URL and connection all come from the
    // container, which a zero-argument factory cannot reach.
    AuthModule.forRootAsync(
      {
        // `DbConnection` is in DatabaseModule's scope, so it has to be named.
        // `AppConfigService` does not: ConfigModule is global.
        imports: [DatabaseModule],
        useFactory: (config: AppConfigService, connection: DbConnection) =>
          authOptions({
            secret: config.get('auth.secret'),
            // The public origin, so cookies and the CSRF origin check are right
            // when the panel is reachable at a real domain rather than localhost.
            baseURL: config.get('appUrl'),
            // The console is same-origin in production; this covers the dev origin
            // (Vite on 5173) and any other origin an operator loads it from.
            trustedOrigins: Array.from(
              new Set([config.get('appUrl'), config.get('corsOrigin')]),
            ),
            database: drizzleDatabase(connection),
            // Closed. `bun run create:admin` is how an operator exists.
            openSignUp: false,
          }),
        inject: [AppConfigService, DbConnection] as const,
      },
      '/auth',
    ),
  ],
  controllers: [ProfileController],
  providers: [AuthTables, Audit],
  /**
   * `Auth` because `OpenApiModule` wraps the root and can only inject what the
   * root exports (see main.ts). `SessionGuard` and `AuthContext` because
   * `AgentsModule` guards its console controller with them, and a container
   * scoped per module means a provider another module injects has to be exported
   * by the module that declares it.
   */
  exports: [Audit, Auth, AuthContext, SessionGuard],
})
export class AccountsModule {}
