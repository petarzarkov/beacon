import { ConfigModule, Module } from '@dunx/core';
import type { ConfigSource } from '@dunx/core';
import { LoggerModule, StreamTransport } from '@dunx/infra/logger';
import { IdentityStore } from './config/identity.js';
import { AgentConfigService, validate } from './config/settings.js';
import { DiagnoseService } from './diagnose/diagnose.service.js';
import { InstallService } from './install/install.service.js';
import { PanelClient } from './panel/panel-client.js';
import { ProbeService } from './probe/probe.service.js';
import { DeployService } from './provision/deploy.service.js';
import { DiscoverService } from './provision/discover.service.js';
import { PropagateService } from './provision/propagate.service.js';
import { RunnerService } from './run/runner.service.js';
import { UpdateService } from './update/update.service.js';

/**
 * The agent is a dunx app rather than a script: the same container, lifecycle and
 * config contract the panel uses, so a service here is constructed and injected
 * the way one there is.
 *
 * `source` is passed rather than left to `Bun.env` because an agent resolves its
 * settings from flags and a config file as well, and `buildSource` is where that
 * precedence lives.
 */
@Module({
  imports: [
    /**
     * Everything to stderr, deliberately.
     *
     * The default console transport splits info to stdout and warnings to
     * stderr, but this binary is a CLI as much as a service: `probe`,
     * `discover`, `whoami` and `propagate --dry-run` each print JSON on stdout
     * that a caller parses, and a log line landing there would corrupt it. A
     * single stream transport to stderr keeps stdout for output alone, which is
     * the Unix convention and also what makes those commands scriptable.
     *
     * Under systemd both streams reach journald anyway, so nothing is lost.
     */
    LoggerModule.forRootAsync({
      useFactory: (config: AgentConfigService) => ({
        name: 'dunxon-agent',
        level: config.get('logLevel'),
        transports: [
          new StreamTransport(process.stderr, {
            level: config.get('logLevel'),
          }),
        ],
      }),
      inject: [AgentConfigService] as const,
    }),
  ],
  providers: [
    IdentityStore,
    ProbeService,
    PanelClient,
    RunnerService,
    UpdateService,
    InstallService,
    DiscoverService,
    DeployService,
    PropagateService,
    DiagnoseService,
  ],
})
export class AgentModule {
  static withSource(
    source: ConfigSource,
  ): ReturnType<typeof ConfigModule.forRoot> {
    return ConfigModule.forRoot({ validate, as: AgentConfigService, source });
  }
}
