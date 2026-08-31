import { AppFactory, Logger, Module } from '@dunx/core';
import { AgentModule } from './agent.module.js';
import { AGENT_VERSION, CONFIG_PATH } from './config/settings.js';
import { buildSource } from './config/source.js';
import { InstallService } from './install/install.service.js';
import { ProbeService } from './probe/probe.service.js';
import { ProvisionService } from './provision/provision.service.js';
import { UpdateService } from './update/update.service.js';

const USAGE = `dunxon-agent ${AGENT_VERSION}

Reports this host to a dunxon panel and keeps itself current.

Usage:
  dunxon-agent run                      Connect and report on the panel's cadence
  dunxon-agent probe                    Print one report locally and exit
  dunxon-agent version                  Print the agent version
  dunxon-agent install [options]        Install and start the service (root)
  dunxon-agent uninstall                Stop and remove the service (root)
  dunxon-agent update                   Pull a newer release if one is published (root)
  dunxon-agent discover                 List hosts on this subnet for the panel

Options:
  --panel-url <url>   Panel base URL, e.g. http://panel.internal:3000
  --token <token>     Shared enrolment token
  --user <name>       Unix user the service runs as (default: dunxon)

Settings resolve from flags, then PANEL_URL / AGENT_TOKEN in the environment,
then ${CONFIG_PATH} written by \`install\`.
`;

const flag = (argv: readonly string[], name: string): string | undefined => {
  const at = argv.indexOf(`--${name}`);
  return at === -1 ? undefined : argv[at + 1];
};

/**
 * `version` answers before the container is built, and that is load bearing: an
 * installer asks the binary its version before deciding whether to replace it, so
 * anything that can fail here reads as "not installed" and causes a reinstall
 * loop on every sweep.
 */
const main = async (): Promise<number> => {
  const argv = process.argv.slice(2);
  const command = argv.find((a) => !a.startsWith('-')) ?? 'run';

  if (command === 'version') {
    console.log(AGENT_VERSION);
    return 0;
  }
  if (command === 'help' || command === '--help') {
    console.log(USAGE);
    return 0;
  }

  @Module({ imports: [AgentModule.withSource(buildSource(argv)), AgentModule] })
  class Root {}

  const app = await AppFactory.create(Root);
  const logger = app.get(Logger);
  try {
    switch (command) {
      case 'probe':
        console.log(JSON.stringify(app.get(ProbeService).collect(), null, 2));
        return 0;
      case 'update':
        return (await app.get(UpdateService).run()) ? 0 : 0;
      case 'install':
        await app.get(InstallService).install(flag(argv, 'user') ?? 'dunxon');
        return 0;
      case 'uninstall':
        await app.get(InstallService).uninstall();
        return 0;
      case 'discover':
        console.log(JSON.stringify(await app.get(ProvisionService).discover()));
        return 0;
      case 'run':
        logger.error('run is not implemented yet', {
          see: 'docs/architecture.md',
        });
        return 1;
      default:
        console.error(`Unknown command "${command}"\n\n${USAGE}`);
        return 1;
    }
  } catch (error) {
    logger.error('command failed', {
      command,
      err: error instanceof Error ? error.message : String(error),
    });
    return 1;
  } finally {
    await app.shutdown();
  }
};

process.exit(await main());
