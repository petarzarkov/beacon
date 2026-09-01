import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  Agent,
  startPanel,
  waitFor,
  type Operator,
  type Panel,
} from './harness/index.js';

/**
 * Agent lifecycle events, against a real agent process.
 *
 * A report says a host is still there; it cannot say a host just arrived or is
 * about to leave. Those are the two moments an operator most wants to see, so the
 * agent reports them out of band: `startup` once it is up and enrolled, and
 * `exit` best-effort as it stops. The one exit it cannot send is the one it dies
 * executing - a `restart` - which is exactly why a clean stop reporting an exit,
 * and a kill reporting none, is a distinction worth proving.
 */
describe('agent lifecycle events', () => {
  let panel: Panel;
  let operator: Operator;

  beforeEach(async () => {
    panel = await startPanel({ reportIntervalMs: 1000 });
    operator = await panel.operator();
  });
  afterEach(async () => {
    await panel.close();
  });

  it('reports a startup event once the agent is up', async () => {
    const agent = await Agent.started(panel);
    try {
      await waitFor(async () => {
        const events = await operator.events(agent.agentId);
        return events.some((event) => event.kind === 'startup');
      }, 'a startup event to be recorded');

      const [startup] = await operator.events(agent.agentId);
      expect(startup?.kind).toBe('startup');
      // The message carries the version, so the log reads on its own.
      expect(startup?.message).toContain('started');
    } finally {
      await agent.dispose();
    }
  });

  it('reports an exit event on a clean stop, and none on a kill', async () => {
    // Clean stop: SIGTERM, the way `systemctl stop` ends it. The agent gets to
    // send its exit before the process goes.
    const graceful = await Agent.started(panel, { machineId: 'graceful' });
    const gracefulId = graceful.agentId;
    await graceful.stop();
    await waitFor(async () => {
      const events = await operator.events(gracefulId);
      return events.some((event) => event.kind === 'exit');
    }, 'a clean stop to report an exit event');

    // A kill is a host losing power: no chance to say anything. It reports a
    // startup and never an exit - the gap the console exists to make visible.
    const killed = await Agent.started(panel, { machineId: 'killed' });
    const killedId = killed.agentId;
    await waitFor(async () => {
      const events = await operator.events(killedId);
      return events.some((event) => event.kind === 'startup');
    }, 'the second agent to report startup before it is killed');
    await killed.kill();

    const killedEvents = await operator.events(killedId);
    expect(killedEvents.some((event) => event.kind === 'startup')).toBe(true);
    expect(killedEvents.some((event) => event.kind === 'exit')).toBe(false);

    await graceful.dispose();
    await killed.dispose();
  });
});
