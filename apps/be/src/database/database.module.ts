import { Module } from '@dunx/core';
import {
  DbConnection,
  DbModule,
  SyncDatabase,
  SyncSqliteOptions,
} from '@dunx/infra/db';
import { AppConfigService } from '../config.js';
import * as schema from './schema.js';

/**
 * The one connection, and nothing else. Every table belongs to the feature that
 * declares it; this module only opens the file they all live in.
 */
@Module({
  imports: [
    // The token comes first, unlike `forRoot`: which class a repository injects
    // is only known once the factory has produced the options.
    //
    // `SyncSqliteOptions` runs SQLite in synchronous mode, so the token is
    // `SyncDatabase` and the repositories can be synchronous throughout.
    // `SqliteOptions` is the default and what an app wants if it might move to
    // Postgres.
    DbModule.forRootAsync(SyncDatabase, {
      useFactory: (config: AppConfigService) =>
        new SyncSqliteOptions({
          // Required: the type argument every constructor below sees.
          schema,
          // A dotted path, checked against AppConfig the same way a top-level
          // key is. `config.get('database').file` still reads the same value.
          filename: config.get('database.file'),
          // `agent_commands` and `discovered_hosts` both reference `agents` with
          // `ON DELETE CASCADE`, which SQLite ignores unless this is on - leaving
          // orphaned commands behind every removed agent.
          pragmas: ['foreign_keys = ON'],
        }),
      inject: [AppConfigService],
    }),
  ],
  /**
   * Re-exported so importers can inject them. `DbModule` exports to this module
   * only; naming them again passes them on.
   */
  exports: [SyncDatabase, DbConnection],
})
export class DatabaseModule {}
