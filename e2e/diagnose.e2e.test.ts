import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  Agent,
  startPanel,
  waitFor,
  type Operator,
  type Panel,
} from './harness/index.js';

/**
 * Remote diagnostics, against a real agent process.
 *
 * A diagnostic is a read-only probe from a fixed allowlist - not an arbitrary
 * shell - and it rides the command lifecycle like any other intent: queued, then
 * run by the agent, then completed with the output as the outcome. These prove
 * the whole round trip, and that the allowlist is enforced.
 */
describe('agent diagnostics', () => {
  let panel: Panel;
  let operator: Operator;

  beforeEach(async () => {
    panel = await startPanel({ reportIntervalMs: 1000 });
    operator = await panel.operator();
  });
  afterEach(async () => {
    await panel.close();
  });

  it('runs a read-only probe and returns its output as the outcome', async () => {
    const agent = await Agent.started(panel);
    try {
      const queued = await operator.diagnose(agent.agentId, 'uptime');
      expect(queued.command).toBe('diagnose');
      expect(queued.state).toBe('queued');

      await waitFor(async () => {
        const command = (
          await operator.commandsFor(agent.agentId, 'recent')
        ).find((c) => c.id === queued.id);
        return command?.state === 'completed';
      }, 'the diagnostic to be collected and completed');

      const done = (await operator.commandsFor(agent.agentId, 'recent')).find(
        (c) => c.id === queued.id,
      );
      // `uptime` output always carries a load average - proof the real command
      // ran and its stdout came back.
      expect(done?.detail).toContain('load average');
    } finally {
      await agent.dispose();
    }
  });

  it('refuses a probe that is not on the allowlist', async () => {
    const agent = await Agent.started(panel);
    try {
      const response = await operator.fetch(
        `/api/agents/${agent.agentId}/diagnose`,
        { method: 'POST', body: JSON.stringify({ probe: 'rm -rf /' }) },
      );
      expect(response.status).toBe(400);
    } finally {
      await agent.dispose();
    }
  });
});
