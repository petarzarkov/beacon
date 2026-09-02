import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  Agent,
  startFleet,
  disposeFleet,
  startPanel,
  waitFor,
  type Operator,
  type Panel,
} from './harness/index.js';

/**
 * Scheduled tasks, against a real agent process.
 *
 * A scheduled task adds *when* to a command, not a new *what* - it is a
 * `Bun.cron` job in dunx's `ScheduleRegistry` that presses "run" on the ordinary
 * command lifecycle. The cadence itself is the framework's and needs no test; what
 * this proves is the wiring around it: that firing a task queues the right command
 * for the right target(s), attributed to the schedule, that the live run state
 * surfaces, that pausing disarms it, and that only an admin may curate.
 *
 * `@hourly` never fires inside a test; `runSchedule` (the registry's `trigger`) is
 * what fires it on demand, which is exactly what it exists for.
 */
describe('scheduled tasks', () => {
  let panel: Panel;
  let admin: Operator;

  beforeEach(async () => {
    panel = await startPanel({ reportIntervalMs: 1000 });
    admin = await panel.operator();
  });
  afterEach(async () => {
    await panel.close();
  });

  it('queues its command for the target when run, attributed to the schedule', async () => {
    const agent = await Agent.started(panel);
    try {
      const task = await admin.addSchedule({
        name: 'uptime-check',
        agentId: agent.agentId,
        action: 'diagnose',
        probe: 'uptime',
        cron: '@hourly',
      });
      expect(task.cron).toBe('@hourly');
      expect(task.enabled).toBe(true);
      // The registry computed the next fire the moment it was armed.
      expect(task.nextRunAt).not.toBeNull();

      // Fire it now, off its cadence.
      await admin.runSchedule(task.id);

      // The agent collects the queued diagnostic and settles it completed, and it
      // is attributed to the schedule, not to a person.
      await waitFor(async () => {
        const commands = await admin.commandsFor(agent.agentId);
        return commands.some(
          (c) => c.command === 'diagnose' && c.state === 'completed',
        );
      }, 'the scheduled diagnostic to run and complete');

      const diagnostic = (await admin.commandsFor(agent.agentId)).find(
        (c) => c.command === 'diagnose',
      );
      expect(diagnostic?.issuedBy).toBe('schedule:uptime-check');

      // And the run shows in the task's live state.
      const listed = (await admin.schedules()).find((t) => t.id === task.id);
      expect(listed?.runs).toBeGreaterThanOrEqual(1);
      expect(listed?.lastRunAt).not.toBeNull();
    } finally {
      await agent.dispose();
    }
  });

  it('pauses and resumes: a disabled task is disarmed and cannot be run', async () => {
    const agent = await Agent.started(panel);
    try {
      const task = await admin.addSchedule({
        name: 'pausable',
        agentId: agent.agentId,
        action: 'report',
        cron: '@hourly',
      });

      await admin.toggleSchedule(task.id, false);
      const paused = (await admin.schedules()).find((t) => t.id === task.id);
      expect(paused?.enabled).toBe(false);
      // Disarmed: no next fire, and running it is refused.
      expect(paused?.nextRunAt).toBeNull();
      const refused = await admin.fetch(
        `/api/agents/schedules/${task.id}/run`,
        { method: 'POST' },
      );
      expect(refused.status).toBe(409);

      // Re-enable and it is armed again.
      await admin.toggleSchedule(task.id, true);
      const resumed = (await admin.schedules()).find((t) => t.id === task.id);
      expect(resumed?.enabled).toBe(true);
      expect(resumed?.nextRunAt).not.toBeNull();
    } finally {
      await agent.dispose();
    }
  });

  it('refuses an unparseable cron with a 400', async () => {
    const response = await admin.fetch('/api/agents/schedules', {
      method: 'POST',
      body: JSON.stringify({
        name: 'bad-cron',
        action: 'report',
        cron: 'not a cron',
      }),
    });
    expect(response.status).toBe(400);
    // And nothing was persisted.
    expect(await admin.schedules()).toHaveLength(0);
  });

  it('a non-admin operator cannot curate schedules', async () => {
    const user = await panel.plainUser();
    const response = await user.fetch('/api/agents/schedules', {
      method: 'POST',
      body: JSON.stringify({
        name: 'nope',
        action: 'report',
        cron: '@hourly',
      }),
    });
    expect(response.status).toBe(403);
    // A plain user can still read them.
    expect(await user.fetch('/api/agents/schedules')).toHaveProperty(
      'status',
      200,
    );
  });

  it('a fleet-wide task queues for every agent', async () => {
    const fleet = await startFleet(panel, 2);
    try {
      const task = await admin.addSchedule({
        name: 'fleet-inventory',
        agentId: null,
        action: 'inventory',
        cron: '@daily',
      });
      await admin.runSchedule(task.id);

      for (const agent of fleet) {
        await waitFor(async () => {
          const commands = await admin.commandsFor(agent.agentId);
          return commands.some((c) => c.command === 'inventory');
        }, `an inventory command queued for ${agent.machineId}`);
      }
    } finally {
      await disposeFleet(fleet);
    }
  });
});
