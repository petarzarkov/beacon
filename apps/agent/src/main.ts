import { AppFactory, Logger, Module } from '@dunx/core';
import { AgentModule } from './agent.module.js';
import {
  AGENT_VERSION,
  CONFIG_PATH,
  DEFAULT_RUN_USER,
} from './config/settings.js';
import { buildSource } from './config/source.js';
import { InstallService } from './install/install.service.js';
import { PanelClient } from './panel/panel-client.js';
import { ProbeService } from './probe/probe.service.js';
import { DiscoverService } from './provision/discover.service.js';
import { PropagateService } from './provision/propagate.service.js';
import { RunnerService } from './run/runner.service.js';
import { UpdateService } from './update/update.service.js';

const USAGE = `beacon-agent ${AGENT_VERSION}

Reports this host to a beacon panel and keeps itself current.

Usage:
  beacon-agent run                      Connect and report on the panel's cadence
  beacon-agent probe                    Print one report locally and exit
  beacon-agent version                  Print the agent version
  beacon-agent whoami                   Print this agent's enrolled identity
  beacon-agent install [options]        Install and start the service (root)
  beacon-agent uninstall                Stop and remove the service (root)
  beacon-agent update                   Pull a newer release if one is published (root)
  beacon-agent discover [--cidr X]      Sweep a subnet and print what answers
  beacon-agent propagate [--dry-run]    Install the agent onto reachable neighbours

Options:
  --panel-url <url>   Panel base URL, e.g. http://panel.internal:3000
  --token <token>     Enrolment token, used once to obtain this agent's own
  --user <name>       Unix user the service runs as (default: ${DEFAULT_RUN_USER})
  --cidr <cidr>       Subnet for \`discover\` (default: this host's own /24)

Settings resolve from flags, then PANEL_URL / AGENT_TOKEN in the environment,
then ${CONFIG_PATH} written by \`install\`.
`;

const flag = (argv: readonly string[], name: string): string | undefined => {
  const withEquals = argv.find((arg) => arg.startsWith(`--${name}=`));
  if (withEquals !== undefined) return withEquals.slice(name.length + 3);
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
  const command = argv.find((arg) => !arg.startsWith('-')) ?? 'run';

  if (command === 'version') {
    console.log(AGENT_VERSION);
    return 0;
  }
  if (command === 'help' || argv.includes('--help')) {
    console.log(USAGE);
    return 0;
  }

  @Module({ imports: [AgentModule.withSource(buildSource(argv)), AgentModule] })
  class Root {}

  const app = await AppFactory.create(Root);
  const logger = app.get(Logger);
  try {
    switch (command) {
      /**
       * Deliberately unauthenticated and local: this is what you run on a host
       * to see exactly what the panel would receive. It needs no panel URL and
       * no identity, so it works on a machine that has never enrolled.
       */
      case 'probe':
        console.log(JSON.stringify(app.get(ProbeService).collect(), null, 2));
        return 0;

      case 'whoami': {
        const identity = app.get(PanelClient).identity();
        if (identity === null) {
          console.log('not enrolled');
          return 1;
        }
        console.log(JSON.stringify(identity, null, 2));
        return 0;
      }

      case 'run':
        await app.get(RunnerService).start();
        return 0;

      case 'update':
        await app.get(UpdateService).run();
        return 0;

      case 'install':
        await app.get(InstallService).install(flag(argv, 'user'));
        return 0;

      case 'uninstall':
        app.get(InstallService).uninstall();
        return 0;

      /**
       * Prints rather than reports. The panel-facing sweep is the `discover`
       * command an operator queues; this is the same code run by hand, for
       * checking what an agent would find before asking a fleet to find it.
       */
      case 'discover': {
        const cidr = flag(argv, 'cidr');
        const found = await app
          .get(DiscoverService)
          .sweep(cidr === undefined ? {} : { cidr });
        console.log(JSON.stringify(found, null, 2));
        return 0;
      }

      /**
       * Runs a propagation pass by hand, which is how it is tested and how an
       * operator checks the blast radius. `--dry-run` sweeps and prints what it
       * would install without touching a neighbour; without it, it installs.
       */
      case 'propagate': {
        const propagation = app.get(PropagateService);
        if (argv.includes('--dry-run')) {
          console.log(
            JSON.stringify(await propagation.plan(flag(argv, 'cidr')), null, 2),
          );
          return 0;
        }
        console.log(JSON.stringify(await propagation.propagate(), null, 2));
        return 0;
      }

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
