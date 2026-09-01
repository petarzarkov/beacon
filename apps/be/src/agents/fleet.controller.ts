import { AuthContext, SessionGuard } from '@dunx/auth';
import {
  Controller,
  Delete,
  Get,
  Post,
  UseGuards,
  type Input,
  type RouteSchemas,
} from '@dunx/http';
import { ApiDoc } from '@dunx/openapi';
import type { ReleaseManifest } from './agent.contract.js';
import {
  deployRoute,
  discoverRoute,
  listCommandsRoute,
  oneAgentRoute,
  queueRoute,
  type AgentView,
  type CommandView,
  type DiscoveryView,
} from './agents.schemas.js';
import { AgentsService } from './agents.service.js';
import { CommandsService } from './commands.service.js';
import { ReleasesService } from './releases.service.js';

/**
 * The operator console's API. Plural `/api/agents`, against the agent's own
 * singular `/api/agent`.
 *
 * `@UseGuards(SessionGuard)` at class scope: everything here is a person acting
 * on a fleet, so every route needs a signed-in one. Nothing is handed a user -
 * `AuthContext` reads the caller `SessionGuard` established out of
 * `AsyncLocalStorage`, which is what lets a queued command be attributed without
 * threading a principal through three signatures.
 *
 * **Every write here returns an intent, not a result.** Queueing a restart
 * answers with a command in state `queued`. That is not a limitation of the
 * implementation, it is the only true thing the panel can say: the agent has not
 * been asked yet, and may never be.
 */
@ApiDoc({
  tags: ['fleet'],
  description:
    'What is reporting, and the intents an operator can queue against it.',
})
@UseGuards(SessionGuard)
@Controller('agents')
export class FleetController {
  constructor(
    private readonly agents: AgentsService,
    private readonly commands: CommandsService,
    private readonly releases: ReleasesService,
    private readonly auth: AuthContext,
  ) {}

  /** The operator, for the audit trail on a command. */
  #issuer(): string {
    return this.auth.require().user.email;
  }

  @ApiDoc({
    summary: 'Every enrolled agent, and whether it is still reporting',
  })
  @Get('/')
  list(): readonly AgentView[] {
    return this.agents.list();
  }

  /**
   * Declared before `/:id` for readability only - `Bun.serve` matches a static
   * segment ahead of a parameter either way.
   */
  @ApiDoc({ summary: 'Outstanding or recent commands across the whole fleet' })
  @Get('/commands', listCommandsRoute)
  commandList(input: Input<typeof listCommandsRoute>): readonly CommandView[] {
    return this.commands.list(input.query.state, input.query.limit);
  }

  @ApiDoc({
    summary: 'Hosts a sweep found that are not managed yet',
    description:
      'Recorded by agents, never acted on. A deployment against one of these is a human decision.',
  })
  @Get('/discovered')
  discovered(): readonly DiscoveryView[] {
    return this.agents.discoveries();
  }

  @ApiDoc({
    summary: 'The release the fleet updates to, or null if none is published',
  })
  @Get('/release')
  release(): ReleaseManifest | null {
    return this.releases.manifest();
  }

  @ApiDoc({ summary: 'One agent' })
  @Get('/:id', oneAgentRoute)
  one(input: Input<typeof oneAgentRoute>): AgentView {
    return this.agents.find(input.params.id);
  }

  /**
   * Answers 201 with a `queued` command. There is deliberately no variant of
   * this that waits for the agent: the wait has no bound, because an agent that
   * is off has not refused, it simply has not arrived.
   */
  @ApiDoc({
    summary: 'Queue an intent. Nothing has happened when this returns.',
  })
  @Post('/:id/commands', queueRoute)
  queue(input: Input<typeof queueRoute>): CommandView {
    return this.commands.queue(
      input.params.id,
      input.body.command,
      this.#issuer(),
    );
  }

  @ApiDoc({
    summary: 'Ask an agent to sweep its subnet and report what answers',
  })
  @Post('/:id/discover', discoverRoute)
  discover(input: Input<typeof discoverRoute>): CommandView {
    return this.commands.queueDiscover(
      input.params.id,
      input.body,
      this.#issuer(),
    );
  }

  /**
   * Install onto a host the panel cannot reach, by asking an agent that can.
   *
   * The caller names a target, never a route to it. The credential is supplied
   * here, per deployment, and travels with the job rather than living on the
   * panel or on any agent - so nothing in the fleet holds a standing key to
   * anything, and a stolen agent is not a way into its neighbours.
   */
  @ApiDoc({
    summary: 'Delegate an install to whichever agent can reach the target',
  })
  @Post('/deployments', deployRoute)
  deploy(input: Input<typeof deployRoute>): CommandView {
    return this.commands.queueDeploy(input.body, this.#issuer());
  }

  @ApiDoc({
    summary: 'Forget an agent',
    description:
      'Its commands go with it. A host still running the agent will re-enrol.',
  })
  @Delete('/:id', oneAgentRoute)
  remove(input: Input<typeof oneAgentRoute>): { deleted: true } {
    this.agents.remove(input.params.id);
    return { deleted: true };
  }

  /** Unused parameter shape kept off the signature: this route takes nothing. */
  @ApiDoc({
    summary: 'Expire anything past its TTL now, rather than on the sweep',
  })
  @Post('/commands/expire')
  expire(_input: Input<RouteSchemas>): { expired: number } {
    return { expired: this.commands.expire() };
  }
}
