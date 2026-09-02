import { describe, expect, it } from 'bun:test';
import { Agent, startPanel, waitFor } from './harness/index.js';

/**
 * Alerting, end to end: rules the panel evaluates, alerts they raise and clear,
 * the RBAC around curating them, and the webhook that carries them out.
 *
 * The panel sees every report, so a threshold is judged on ingest and silence on
 * the sweep - both proven here against a real agent, with the alert lifecycle
 * (fire → ack, fire → auto-resolve) and a real webhook delivery.
 */
describe('alerting', () => {
  it('fires a metric-threshold alert and acknowledges it', async () => {
    const panel = await startPanel({ reportIntervalMs: 1000 });
    const admin = await panel.operator();
    const agent = await Agent.started(panel);
    try {
      // The agent's own RSS is tens of MB, so "> 1 MB" fires on the next report.
      await admin.addAlertRule({
        name: 'mem-hot',
        kind: 'metric_threshold',
        metric: 'agent_mem_mb',
        comparator: 'gt',
        threshold: 1,
      });

      await waitFor(async () => {
        const active = await admin.alerts('active');
        return active.some(
          (a) => a.agentId === agent.agentId && a.state === 'firing',
        );
      }, 'a metric alert to fire');

      const alert = (await admin.alerts('active')).find(
        (a) => a.agentId === agent.agentId,
      );
      expect(alert?.message).toContain('agent_mem_mb');

      await admin.ackAlert(alert!.id);
      await waitFor(async () => {
        const found = (await admin.alerts('active')).find(
          (a) => a.id === alert!.id,
        );
        return found?.state === 'acknowledged';
      }, 'the alert to be acknowledged');
    } finally {
      await agent.dispose();
      await panel.close();
    }
  });

  it('fires on silence and resolves when the agent returns', async () => {
    const panel = await startPanel({ reportIntervalMs: 1000 });
    const admin = await panel.operator();
    const agent = await Agent.started(panel);
    try {
      await admin.addAlertRule({
        name: 'gone',
        kind: 'agent_silent',
        silenceSeconds: 1,
      });

      await agent.kill();
      // The sweep judges silence; force it rather than wait out the interval.
      await waitFor(async () => {
        await admin.expire();
        return (await admin.alerts('active')).some(
          (a) => a.agentId === agent.agentId && a.kind === 'agent_silent',
        );
      }, 'a silence alert to fire');

      // A report is proof of life: bring the agent back and the alert clears.
      await agent.start();
      await waitFor(async () => {
        const stillFiring = (await admin.alerts('active')).some(
          (a) => a.agentId === agent.agentId && a.kind === 'agent_silent',
        );
        return !stillFiring;
      }, 'the silence alert to resolve');
    } finally {
      await agent.dispose();
      await panel.close();
    }
  });

  it('lets a non-admin read alerts and rules but not curate them', async () => {
    const panel = await startPanel();
    await panel.operator();
    const plain = await panel.plainUser();
    try {
      // Reading is allowed.
      expect(Array.isArray(await plain.alerts())).toBe(true);
      expect(Array.isArray(await plain.alertRules())).toBe(true);

      // Creating a rule is not.
      const denied = await plain.fetch('/api/agents/alert-rules', {
        method: 'POST',
        body: JSON.stringify({ name: 'nope', kind: 'command_failed' }),
      });
      expect(denied.status).toBe(403);
    } finally {
      await panel.close();
    }
  });

  it('delivers a firing alert to the configured webhook', async () => {
    const received: { event: string; hostname: string }[] = [];
    const receiver = Bun.serve({
      port: 0,
      async fetch(request) {
        received.push(
          (await request.json()) as { event: string; hostname: string },
        );
        return new Response('ok');
      },
    });
    const panel = await startPanel({ reportIntervalMs: 1000 });
    const admin = await panel.operator();
    let agent: Agent | undefined;
    try {
      await admin.setAlertWebhook(receiver.url.toString());
      await admin.addAlertRule({
        name: 'mem-hot',
        kind: 'metric_threshold',
        metric: 'agent_mem_mb',
        comparator: 'gt',
        threshold: 1,
      });
      agent = await Agent.started(panel);

      await waitFor(
        () => received.some((r) => r.event === 'firing'),
        'the webhook to receive a firing event',
      );
      expect(received.find((r) => r.event === 'firing')?.hostname).toBeTruthy();
    } finally {
      if (agent) await agent.dispose();
      await panel.close();
      receiver.stop(true);
    }
  });
});
