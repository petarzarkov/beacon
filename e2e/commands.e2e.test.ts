import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import {
  Agent,
  startPanel,
  waitFor,
  type Operator,
  type Panel,
} from './harness/index.js';

/**
 * The command lifecycle, against a real agent process.
 *
 * `queued -> delivered -> completed | failed | expired`, and the two cases the
 * whole design turns on: a command is only ever an intent until the agent
 * collects it, and `restart` - which the agent cannot acknowledge, because it
 * dies running it - is completed by the panel noticing a younger process report.
 */
describe('commands', () => {
  let panel: Panel;
  let operator: Operator;
  let agent: Agent;

  beforeAll(async () => {
    panel = await startPanel({ reportIntervalMs: 1000 });
    operator = await panel.operator();
    agent = await Agent.started(panel);
  });

  afterAll(async () => {
    await agent.dispose();
    await panel.close();
  });

  it('queues a command as an intent, settling only once the agent runs it', async () => {
    const queued = await operator.queue(agent.agentId, 'report');
    // The honest answer at the moment of queueing: nothing has happened.
    expect(queued.state).toBe('queued');
    expect(queued.settledAt).toBeNull();

    await waitFor(async () => {
      const [command] = await operator.commandsFor(agent.agentId, 'recent');
      return command?.id === queued.id && command.state === 'completed';
    }, 'the report command to be collected and completed');
  });

  it('records who issued a command', async () => {
    const queued = await operator.queue(agent.agentId, 'report');
    expect(queued.issuedBy).toContain('@example.com');
  });

  /**
   * The one command with no acknowledgement. The agent process ends, so success
   * is a *new* process reporting in - which the harness produces by letting the
   * agent exit and starting it again, the way systemd's `Restart=always` would.
   */
  it('completes a restart when the agent comes back as a new process', async () => {
    const queued = await operator.queue(agent.agentId, 'restart');

    // The real process must actually end - proof the agent obeyed rather than
    // reporting success and carrying on.
    const code = await agent.waitForExit(15_000);
    expect(code).not.toBeNull();

    // systemd brings it back; same identity, fresh uptime.
    await agent.start();
    await waitFor(async () => {
      const command = (
        await operator.commandsFor(agent.agentId, 'recent')
      ).find((c) => c.id === queued.id);
      return command?.state === 'completed';
    }, 'the restart to be completed by a younger process reporting');

    const restart = (await operator.commandsFor(agent.agentId, 'recent')).find(
      (c) => c.id === queued.id,
    );
    expect(restart?.detail).toContain('uptime');
  });

  it('expires a command that is never collected, on its TTL', async () => {
    // A second agent, kept dark: its command can only ever expire.
    const dark = Agent.create(panel, { machineId: 'never-runs' });
    // Enrol it (so a row exists) then stop it, so it will not collect anything.
    await dark.start();
    const darkId = dark.agentId;
    await dark.kill();

    // A TTL shorter than the test, applied by queueing against a panel whose
    // command TTL is small.
    const shortTtl = await startPanel({ commandTtlMs: 10_000 });
    try {
      const shortOp = await shortTtl.operator();
      const darkOnShort = await Agent.started(shortTtl, {
        machineId: 'dark-on-short',
      });
      await darkOnShort.kill();

      const queued = await shortOp.queue(darkOnShort.agentId, 'restart');
      // Force the sweep rather than waiting the full TTL out in real time is not
      // possible - the TTL is real - so wait for it, then sweep.
      await waitFor(
        async () => {
          await shortOp.expire();
          const command = (
            await shortOp.commandsFor(darkOnShort.agentId, 'recent')
          ).find((c) => c.id === queued.id);
          return command?.state === 'expired';
        },
        'the uncollected command to expire',
        20_000,
      );
      await darkOnShort.dispose();
    } finally {
      await dark.dispose();
      await shortTtl.close();
    }
    expect(darkId).toBeTruthy();
  });

  it('refuses to queue an update when no release is published', async () => {
    // This panel has no release, so there is nothing to update to.
    const response = await operator.fetch(
      `/api/agents/${agent.agentId}/commands`,
      { method: 'POST', body: JSON.stringify({ command: 'update' }) },
    );
    expect(response.status).toBe(409);
  });
});
