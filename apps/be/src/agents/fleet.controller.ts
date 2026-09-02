import { AuthContext, SessionGuard } from '@dunx/auth';
import {
  Controller,
  Delete,
  Get,
  Post,
  Put,
  Roles,
  UseGuards,
  type Input,
  type RouteSchemas,
} from '@dunx/http';
import { ApiDoc } from '@dunx/openapi';
import type {
  AgentEventView,
  AgentMetricPoint,
  AgentView,
  AlertRuleView,
  AlertView,
  CommandLibraryEntry,
  CommandView,
  DiscoveryView,
  FleetSettings,
  InventoryView,
  ReleaseManifest,
} from '@beacon/contract';
import {
  agentEventsRoute,
  agentMetricsRoute,
  alertIdRoute,
  alertRuleIdRoute,
  alertsRoute,
  alertWebhookRoute,
  createAlertRuleRoute,
  createLibraryRoute,
  deployRoute,
  diagnoseRoute,
  discoverRoute,
  execRawRoute,
  execRoute,
  libraryIdRoute,
  listCommandsRoute,
  oneAgentRoute,
  queueRoute,
  settingsRoute,
} from './agents.schemas.js';
import { AgentsService } from './agents.service.js';
import { AlertsService } from './alerts.service.js';
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
    private readonly alerts: AlertsService,
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

  /**
   * The fleet-wide switches an operator controls live. Just the propagation kill
   * switch today - a static segment, so declared before `/:id`.
   */
  @ApiDoc({ summary: 'Fleet-wide settings (the propagation kill switch)' })
  @Get('/settings')
  settings(): FleetSettings {
    return {
      propagationAllowed: this.agents.propagationAllowed(),
      allowArbitraryExec: this.agents.allowArbitraryExec(),
      alertWebhookUrl: this.alerts.webhookUrl(),
    };
  }

  /**
   * Arm or pause autonomous self-propagation across the whole fleet.
   *
   * `@Roles('admin')`: this turns a worm-shaped capability on or off for every
   * host at once, which is not a decision any signed-in user should be able to
   * make. It is still only one of two keys - a host also has to be locally opted
   * in - but arming it fleet-wide is the consequential half.
   */
  @Roles('admin')
  @ApiDoc({ summary: 'Arm or pause fleet-wide self-propagation (admin)' })
  @Put('/settings', settingsRoute)
  setSettings(input: Input<typeof settingsRoute>): FleetSettings {
    return {
      propagationAllowed: this.agents.setPropagationAllowed(
        input.body.propagationAllowed,
        this.#issuer(),
      ),
      allowArbitraryExec: this.agents.allowArbitraryExec(),
      alertWebhookUrl: this.alerts.webhookUrl(),
    };
  }

  // --- Alerting --------------------------------------------------------------
  // Static segments, declared before `/:id`.

  @ApiDoc({ summary: 'Alerts (firing/acknowledged, or all)' })
  @Get('/alerts', alertsRoute)
  alerts_(input: Input<typeof alertsRoute>): readonly AlertView[] {
    return this.alerts.listAlerts(input.query.scope, input.query.limit);
  }

  @ApiDoc({ summary: 'Acknowledge an alert' })
  @Post('/alerts/:id/ack', alertIdRoute)
  ackAlert(input: Input<typeof alertIdRoute>): { acknowledged: true } {
    this.alerts.acknowledge(input.params.id, this.#issuer());
    return { acknowledged: true };
  }

  @ApiDoc({ summary: 'The alerting rules' })
  @Get('/alert-rules')
  alertRules(): readonly AlertRuleView[] {
    return this.alerts.listRules();
  }

  @Roles('admin')
  @ApiDoc({ summary: 'Create an alerting rule (admin)' })
  @Post('/alert-rules', createAlertRuleRoute)
  addAlertRule(input: Input<typeof createAlertRuleRoute>): AlertRuleView {
    return this.alerts.createRule(input.body, this.#issuer());
  }

  @Roles('admin')
  @ApiDoc({ summary: 'Delete an alerting rule (admin)' })
  @Delete('/alert-rules/:id', alertRuleIdRoute)
  removeAlertRule(input: Input<typeof alertRuleIdRoute>): { deleted: true } {
    this.alerts.deleteRule(input.params.id);
    return { deleted: true };
  }

  @Roles('admin')
  @ApiDoc({ summary: 'Set (or clear) the alert notification webhook (admin)' })
  @Put('/alert-webhook', alertWebhookRoute)
  setAlertWebhook(input: Input<typeof alertWebhookRoute>): FleetSettings {
    const url = input.body.url.trim();
    this.alerts.setWebhookUrl(url === '' ? null : url, this.#issuer());
    return this.settings();
  }

  /**
   * The command library (Tier 1). Any operator may read it and run an entry;
   * only an admin may curate it - static segments, so declared before `/:id`.
   */
  @ApiDoc({ summary: 'The admin-curated library of runnable commands' })
  @Get('/library')
  library(): readonly CommandLibraryEntry[] {
    return this.commands.listLibrary();
  }

  @Roles('admin')
  @ApiDoc({ summary: 'Add a command to the library (admin)' })
  @Post('/library', createLibraryRoute)
  addLibrary(input: Input<typeof createLibraryRoute>): CommandLibraryEntry {
    return this.commands.createLibraryEntry(input.body, this.#issuer());
  }

  @Roles('admin')
  @ApiDoc({ summary: 'Remove a command from the library (admin)' })
  @Delete('/library/:id', libraryIdRoute)
  removeLibrary(input: Input<typeof libraryIdRoute>): { deleted: true } {
    this.commands.deleteLibraryEntry(input.params.id);
    return { deleted: true };
  }

  @ApiDoc({ summary: 'One agent' })
  @Get('/:id', oneAgentRoute)
  one(input: Input<typeof oneAgentRoute>): AgentView {
    return this.agents.find(input.params.id);
  }

  @ApiDoc({
    summary: 'One agent’s lifecycle events (startup, exit), newest first',
  })
  @Get('/:id/events', agentEventsRoute)
  events(input: Input<typeof agentEventsRoute>): readonly AgentEventView[] {
    return this.agents.events(input.params.id, input.query.limit);
  }

  @ApiDoc({
    summary: 'One agent’s metric history (memory, CPU, load), oldest first',
  })
  @Get('/:id/metrics', agentMetricsRoute)
  metrics(input: Input<typeof agentMetricsRoute>): readonly AgentMetricPoint[] {
    return this.agents.metrics(input.params.id, input.query.minutes);
  }

  @ApiDoc({
    summary: 'One agent’s hardware and OS inventory, or null if none reported',
  })
  @Get('/:id/inventory', oneAgentRoute)
  inventory(input: Input<typeof oneAgentRoute>): InventoryView | null {
    return this.agents.inventory(input.params.id);
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
   * Queue a read-only diagnostic. Its output rides back as the command's outcome
   * detail, so it appears in the command history like any other intent.
   */
  @ApiDoc({ summary: 'Run a read-only diagnostic probe on an agent' })
  @Post('/:id/diagnose', diagnoseRoute)
  diagnose(input: Input<typeof diagnoseRoute>): CommandView {
    return this.commands.queueDiagnose(
      input.params.id,
      input.body.probe,
      this.#issuer(),
    );
  }

  /** Tier 1: run a library command. Any operator; the allowlist is the library. */
  @ApiDoc({ summary: 'Run a library command on an agent' })
  @Post('/:id/exec', execRoute)
  exec(input: Input<typeof execRoute>): CommandView {
    return this.commands.queueExecLibrary(
      input.params.id,
      input.body.libraryId,
      this.#issuer(),
    );
  }

  /**
   * Tier 2: run a free-form command. `@Roles('admin')` and the service also
   * refuses unless `ALLOW_ARBITRARY_EXEC` is set - real remote execution, so two
   * gates, not one.
   */
  @Roles('admin')
  @ApiDoc({ summary: 'Run a free-form command on an agent (admin, gated)' })
  @Post('/:id/exec-raw', execRawRoute)
  execRaw(input: Input<typeof execRawRoute>): CommandView {
    return this.commands.queueExecArbitrary(
      input.params.id,
      input.body.command,
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

  /**
   * Run the periodic sweep now rather than waiting for its interval: expire
   * commands past their TTL, prune old metrics, and re-evaluate silence alerts.
   * Unused parameter shape kept off the signature: this route takes nothing.
   */
  @ApiDoc({
    summary: 'Run the sweep now (expire TTLs, evaluate silence)',
  })
  @Post('/commands/expire')
  expire(_input: Input<RouteSchemas>): { expired: number } {
    return { expired: this.agents.sweep() };
  }
}
