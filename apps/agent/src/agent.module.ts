import { ConfigModule, Module } from '@dunx/core';
import type { ConfigSource } from '@dunx/core';
import { AgentConfigService, validate } from './config/settings.js';
import { InstallService } from './install/install.service.js';
import { PanelClient } from './panel/panel-client.js';
import { ProbeService } from './probe/probe.service.js';
import { ProvisionService } from './provision/provision.service.js';
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
  imports: [],
  providers: [
    ProbeService,
    PanelClient,
    UpdateService,
    InstallService,
    ProvisionService,
  ],
})
export class AgentModule {
  static withSource(
    source: ConfigSource,
  ): ReturnType<typeof ConfigModule.forRoot> {
    return ConfigModule.forRoot({ validate, as: AgentConfigService, source });
  }
}
