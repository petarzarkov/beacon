import { Logger } from '@dunx/core';
import { HttpError, HttpStatusCode } from '@dunx/http';
import type {
  AlertMetric,
  AlertRuleView,
  AlertView,
  HostReport,
} from '@beacon/contract';
import {
  AgentsRepository,
  type AgentRow,
  type AlertRow,
  type AlertRuleRow,
} from './agents.repository.js';

/** The fleet setting that holds where alert notifications are POSTed. */
const WEBHOOK_KEY = 'alert_webhook_url';

/** What a new alert-rule looks like before the panel assigns it an id. */
export interface NewAlertRule {
  readonly name: string;
  readonly kind: AlertRuleView['kind'];
  readonly metric?: AlertMetric | undefined;
  readonly comparator?: AlertRuleView['comparator'] | undefined;
  readonly threshold?: number | undefined;
  readonly silenceSeconds?: number | undefined;
}

/**
 * Alerting: rules the panel evaluates, alerts they raise, and the webhook that
 * carries them out.
 *
 * The panel is where every report lands, so a threshold is judged on ingest and
 * silence on the sweep - no agent change for either. An alert is deduped to one
 * open row per (rule, agent): a condition that stays true updates its alert
 * rather than piling up, and clears itself when the condition passes. A failed
 * command is the exception - a point event an operator acknowledges.
 */
export class AlertsService {
  constructor(
    private readonly repo: AgentsRepository,
    private readonly logger: Logger,
  ) {}

  // --- Rules (the controller's CRUD) -----------------------------------------

  listRules(): readonly AlertRuleView[] {
    return this.repo.listRules().map(toRuleView);
  }

  createRule(input: NewAlertRule, by: string | null): AlertRuleView {
    const row: AlertRuleRow = {
      id: crypto.randomUUID(),
      name: input.name,
      kind: input.kind,
      metric: input.metric ?? null,
      comparator: input.comparator ?? null,
      threshold: input.threshold ?? null,
      silenceSeconds: input.silenceSeconds ?? null,
      enabled: true,
      createdAt: new Date().toISOString(),
      createdBy: by,
    };
    this.repo.createRule(row);
    this.logger.info('alert rule created', { name: row.name, kind: row.kind });
    return toRuleView(row);
  }

  deleteRule(id: string): void {
    if (!this.repo.deleteRule(id)) {
      throw new HttpError(HttpStatusCode.NOT_FOUND, `No alert rule ${id}`);
    }
  }

  // --- Alerts (the controller's list + ack) ----------------------------------

  listAlerts(scope: 'active' | 'all', limit: number): readonly AlertView[] {
    const rules = new Map(this.repo.listRules().map((r) => [r.id, r]));
    const agents = new Map(this.repo.list().map((a) => [a.id, a.hostname]));
    return this.repo
      .listAlerts(scope, limit)
      .map((row) =>
        toAlertView(
          row,
          rules.get(row.ruleId)?.name ?? '(deleted rule)',
          rules.get(row.ruleId)?.kind ?? 'metric_threshold',
          agents.get(row.agentId) ?? row.agentId.slice(0, 8),
        ),
      );
  }

  countActive(): number {
    return this.repo.countActiveAlerts();
  }

  acknowledge(id: string, by: string | null): void {
    if (this.repo.findAlert(id) === null) {
      throw new HttpError(HttpStatusCode.NOT_FOUND, `No alert ${id}`);
    }
    this.repo.ackAlert(id, new Date().toISOString(), by);
  }

  webhookUrl(): string | null {
    return this.repo.setting(WEBHOOK_KEY);
  }

  setWebhookUrl(url: string | null, by: string | null): void {
    this.repo.putSetting(WEBHOOK_KEY, url ?? '', new Date().toISOString(), by);
  }

  // --- Evaluation ------------------------------------------------------------

  /** Judge every threshold rule against a fresh report, and clear silence. */
  evaluateReport(agent: AgentRow, report: HostReport): void {
    const at = new Date().toISOString();
    for (const rule of this.repo.enabledRules()) {
      if (rule.kind === 'agent_silent') {
        // A report is proof of life: whatever silence alert stood, clear it.
        this.#resolve(rule, agent.id, at);
        continue;
      }
      if (rule.kind !== 'metric_threshold') continue;
      const value = metricOf(rule.metric, report);
      if (value === null) continue;
      if (trips(value, rule)) {
        this.#fire(rule, agent, messageFor(rule, value), value, at);
      } else {
        this.#resolve(rule, agent.id, at);
      }
    }
  }

  /** Judge silence on the sweep - the one condition that is the absence of data. */
  evaluateSilence(now: number = Date.now()): void {
    const at = new Date(now).toISOString();
    const silenceRules = this.repo
      .enabledRules()
      .filter((r) => r.kind === 'agent_silent');
    if (silenceRules.length === 0) return;
    for (const agent of this.repo.list()) {
      const silentFor = (now - Date.parse(agent.lastSeenAt)) / 1000;
      for (const rule of silenceRules) {
        if (silentFor > (rule.silenceSeconds ?? 0)) {
          this.#fire(
            rule,
            agent,
            `silent for ${Math.round(silentFor)}s (limit ${rule.silenceSeconds}s)`,
            Math.round(silentFor),
            at,
          );
        } else {
          this.#resolve(rule, agent.id, at);
        }
      }
    }
  }

  /** A command settled `failed`: raise any command_failed rule for that agent. */
  onCommandFailed(agentId: string, detail: string): void {
    const agent = this.repo.find(agentId);
    if (agent === null) return;
    const at = new Date().toISOString();
    for (const rule of this.repo.enabledRules()) {
      if (rule.kind !== 'command_failed') continue;
      this.#fire(rule, agent, `command failed: ${detail}`, null, at);
    }
  }

  #fire(
    rule: AlertRuleRow,
    agent: AgentRow,
    message: string,
    value: number | null,
    at: string,
  ): void {
    const existing = this.repo.activeAlert(rule.id, agent.id);
    if (existing !== null) {
      this.repo.touchAlert(existing.id, at, value);
      return;
    }
    const row: AlertRow = {
      id: crypto.randomUUID(),
      ruleId: rule.id,
      agentId: agent.id,
      state: 'firing',
      message,
      value,
      firedAt: at,
      updatedAt: at,
      resolvedAt: null,
      acknowledgedAt: null,
      acknowledgedBy: null,
    };
    this.repo.insertAlert(row);
    this.logger.warn('alert firing', {
      rule: rule.name,
      agent: agent.hostname,
      message,
    });
    this.#notify('firing', rule, agent, message);
  }

  #resolve(rule: AlertRuleRow, agentId: string, at: string): void {
    const existing = this.repo.activeAlert(rule.id, agentId);
    if (existing === null) return;
    this.repo.resolveAlert(existing.id, at);
    const agent = this.repo.find(agentId);
    this.logger.info('alert resolved', { rule: rule.name, agentId });
    if (agent !== null) this.#notify('resolved', rule, agent, existing.message);
  }

  /**
   * Best-effort webhook, fire-and-forget: a notification that fails must never
   * fail the report that raised it, so this never throws and is not awaited.
   */
  #notify(
    event: 'firing' | 'resolved',
    rule: AlertRuleRow,
    agent: AgentRow,
    message: string,
  ): void {
    const url = this.repo.setting(WEBHOOK_KEY);
    if (url === null || url === '') return;
    const body = JSON.stringify({
      event,
      rule: rule.name,
      kind: rule.kind,
      agentId: agent.id,
      hostname: agent.hostname,
      message,
      at: new Date().toISOString(),
    });
    void fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
      signal: AbortSignal.timeout(10_000),
    }).catch((error: unknown) =>
      this.logger.warn('alert webhook failed', {
        err: error instanceof Error ? error.message : String(error),
      }),
    );
  }
}

/** Pull the metric a rule watches out of a report, or null if unavailable. */
const metricOf = (
  metric: AlertMetric | null,
  report: HostReport,
): number | null => {
  switch (metric) {
    case 'agent_cpu':
      return report.agentCpuPercent;
    case 'agent_mem_mb':
      return Math.round((report.agentMemBytes / 1024 / 1024) * 10) / 10;
    case 'host_load1':
      return report.load1;
    case 'host_mem_pct':
      return report.memTotalBytes > 0
        ? Math.round(
            ((report.memTotalBytes - report.memFreeBytes) /
              report.memTotalBytes) *
              1000,
          ) / 10
        : null;
    default:
      return null;
  }
};

const trips = (value: number, rule: AlertRuleRow): boolean => {
  if (rule.threshold === null) return false;
  return rule.comparator === 'lt'
    ? value < rule.threshold
    : value > rule.threshold;
};

const messageFor = (rule: AlertRuleRow, value: number): string =>
  `${rule.metric} is ${value} (${rule.comparator === 'lt' ? '<' : '>'} ${rule.threshold})`;

const toRuleView = (row: AlertRuleRow): AlertRuleView => ({
  id: row.id,
  name: row.name,
  kind: row.kind,
  metric: row.metric,
  comparator: row.comparator,
  threshold: row.threshold,
  silenceSeconds: row.silenceSeconds,
  enabled: row.enabled,
  createdAt: row.createdAt,
  createdBy: row.createdBy,
});

const toAlertView = (
  row: AlertRow,
  ruleName: string,
  kind: AlertRuleView['kind'],
  agentHostname: string,
): AlertView => ({
  id: row.id,
  ruleId: row.ruleId,
  ruleName,
  kind,
  agentId: row.agentId,
  agentHostname,
  state: row.state,
  message: row.message,
  value: row.value,
  firedAt: row.firedAt,
  resolvedAt: row.resolvedAt,
  acknowledgedAt: row.acknowledgedAt,
  acknowledgedBy: row.acknowledgedBy,
});
