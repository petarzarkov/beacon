import { Module } from '@dunx/core';
import { ScheduleModule } from '@dunx/infra/schedule';
import { AppConfigService } from '../config.js';
import { AccountsModule } from '../auth/auth.module.js';
import { DatabaseModule } from '../database/database.module.js';
import { AgentController } from './agent.controller.js';
import { AgentsRepository } from './agents.repository.js';
import { AgentsService } from './agents.service.js';
import { AlertsService } from './alerts.service.js';
import { CommandsService } from './commands.service.js';
import { FleetController } from './fleet.controller.js';
import { ReleasesService } from './releases.service.js';
import { ScheduleService } from './schedule.service.js';

/**
 * The feature this repo exists for. Two controllers, because an agent and an
 * operator are different callers with different credentials - see
 * `agent.controller.ts` for why they are not one.
 *
 * `AccountsModule` is imported for `SessionGuard` and `AuthContext`, which the
 * console controller needs and the agent controller must never see; the
 * container being scoped per module is what makes that a wiring fact rather than
 * a convention.
 */
@Module({
  imports: [
    DatabaseModule,
    AccountsModule,
    /**
     * Armed here rather than app-wide because the fleet holds the only schedule
     * in this app: expiring commands past their TTL. `keepAlive: false` because
     * the server holds the event loop open already, and a CLI script that boots
     * the container has to be able to exit.
     */
    ScheduleModule.forRootAsync({
      useFactory: (config: AppConfigService) => ({
        tz: config.get('schedule').tz,
        keepAlive: false,
      }),
      inject: [AppConfigService] as const,
    }),
  ],
  controllers: [AgentController, FleetController],
  providers: [
    AgentsRepository,
    AgentsService,
    AlertsService,
    CommandsService,
    ReleasesService,
    ScheduleService,
  ],
  // `ReleasesService` so the health probe can report whether a release exists;
  // `AgentsService` so it can count the fleet. The repository stays private -
  // nothing outside this module should be writing agent rows.
  exports: [AgentsService, CommandsService, ReleasesService],
})
export class AgentsModule {}
