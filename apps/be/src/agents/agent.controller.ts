import {
  ClientAddress,
  Controller,
  Get,
  HttpError,
  HttpStatusCode,
  Post,
  Public,
  type Input,
  type RouteSchemas,
} from '@dunx/http';
import { ApiDoc } from '@dunx/openapi';
import type { BunRequest } from 'bun';
import {
  AGENT_HEADER,
  ENROLMENT_HEADER,
  type EnrolResponse,
  type ReleaseManifest,
  type ReportResponse,
} from '@dunxon/contract';
import type { AgentRow } from './agents.repository.js';
import {
  discoveredRoute,
  enrolRoute,
  eventsRoute,
  outcomesRoute,
  reportRoute,
} from './agents.schemas.js';
import { AgentsService } from './agents.service.js';
import { CommandsService } from './commands.service.js';
import { normalizeAddress } from './enrolment.js';
import { ReleasesService } from './releases.service.js';

/**
 * Everything an agent talks to, and nothing an operator does.
 *
 * Singular `/api/agent` against the console's plural `/api/agents`, because the
 * two have different callers, different credentials and different lifetimes. One
 * controller serving both would mean a single mistake in a guard exposing the
 * fleet to anything holding an agent token.
 *
 * `@Public()` means these bypass `SessionGuard` - an agent has no browser
 * session - not that they are unauthenticated. Every one presents a token,
 * checked in `#agent()` rather than by a guard class, because a guard whose whole
 * body is a lookup and a throw is a class more than those two lines are worth.
 */
@ApiDoc({
  tags: ['agent'],
  description:
    'The agent protocol: enrol, report, collect commands, pull releases. Authenticated by token, never by session.',
})
@Public()
@Controller('agent')
export class AgentController {
  constructor(
    private readonly agents: AgentsService,
    private readonly commands: CommandsService,
    private readonly releases: ReleasesService,
    private readonly address: ClientAddress,
  ) {}

  /**
   * `undefined` from `ClientAddress` becomes `null`: one absent value, not two.
   * Normalised so a host is one string regardless of how the socket spells a
   * loopback or IPv4-mapped peer - see `normalizeAddress`.
   */
  #ipOf(req: BunRequest): string | null {
    return normalizeAddress(this.address.of(req) ?? null);
  }

  #agent(req: BunRequest): AgentRow {
    const agent = this.agents.authenticate(req.headers.get(AGENT_HEADER));
    if (agent === null) {
      throw new HttpError(
        HttpStatusCode.UNAUTHORIZED,
        'Unknown or missing agent token. Enrol first.',
      );
    }
    return agent;
  }

  @ApiDoc({
    summary: 'Exchange an enrolment credential for this agent’s own identity',
  })
  @Post('/enrol', enrolRoute)
  enrol(input: Input<typeof enrolRoute>): EnrolResponse {
    return this.agents.enrol(
      input.body,
      input.req.headers.get(ENROLMENT_HEADER),
      this.#ipOf(input.req),
    );
  }

  /**
   * The only event in the system.
   *
   * The panel cannot dial an agent, so a report is not just data arriving - it is
   * the one moment at which anything can be handed back. Queued commands ride
   * out on this response, which is why there is no separate "poll for work"
   * route: it would be this one with the report removed.
   */
  @ApiDoc({ summary: 'Report this host, and collect anything queued for it' })
  @Post('/report', reportRoute)
  report(input: Input<typeof reportRoute>): ReportResponse {
    return this.agents.ingest(
      this.#agent(input.req),
      input.body,
      this.#ipOf(input.req),
    );
  }

  /**
   * Reported after the fact, and separately from the report that delivered the
   * command. A `restart` is the reason: the agent is gone before it could put an
   * outcome anywhere, so outcomes cannot be part of the same exchange that
   * hands commands out.
   */
  @ApiDoc({ summary: 'Report what happened to commands this agent collected' })
  @Post('/outcomes', outcomesRoute)
  outcomes(input: Input<typeof outcomesRoute>): { settled: number } {
    const agent = this.#agent(input.req);
    return {
      settled: this.commands.settle(
        agent.id,
        input.body.outcomes,
        new Date().toISOString(),
      ),
    };
  }

  /**
   * Lifecycle events, sent out of band from the report loop: `startup` once the
   * agent is up, `exit` best-effort on a clean stop. Separate from a report
   * because an exit has to be sent as the process is ending, not held for the
   * next interval that will never come.
   */
  @ApiDoc({ summary: 'Report lifecycle events (startup, exit)' })
  @Post('/events', eventsRoute)
  events(input: Input<typeof eventsRoute>): { recorded: number } {
    const agent = this.#agent(input.req);
    return { recorded: this.agents.recordEvents(agent, input.body.events) };
  }

  @ApiDoc({ summary: 'Report hosts found on this agent’s subnet' })
  @Post('/discovered', discoveredRoute)
  discovered(input: Input<typeof discoveredRoute>): { recorded: number } {
    const agent = this.#agent(input.req);
    return { recorded: this.agents.recordDiscoveries(agent, input.body.hosts) };
  }

  @ApiDoc({
    summary: 'The published release, which an update verifies against',
  })
  @Get('/release')
  release(input: Input<RouteSchemas>): ReleaseManifest {
    this.#agent(input.req);
    return this.releases.manifestOrThrow();
  }

  /**
   * Token-checked like everything else here. The binary is not a secret, but
   * serving it to anyone would let a stranger enumerate the exact build a fleet
   * runs, and the panel already knows who is entitled to it.
   */
  @ApiDoc({ summary: 'Download the published agent binary' })
  @Get('/release/binary')
  binary(input: Input<RouteSchemas>): Response {
    this.#agent(input.req);
    return this.releases.binary();
  }
}
