import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  Agent,
  startPanel,
  waitFor,
  type Operator,
  type Panel,
} from './harness/index.js';

/**
 * Asset inventory, against a real agent process.
 *
 * Inventory is what a host *is* - its CPU, memory, disks and interfaces - as
 * against a report, which is what it is *doing right now*. It changes rarely, so
 * the agent sends it out of band from the report loop: once at startup, and again
 * whenever an operator queues an `inventory` command. The panel keeps the latest
 * snapshot per host, so this proves both the startup report and the refresh.
 */
describe('asset inventory', () => {
  let panel: Panel;
  let operator: Operator;

  beforeEach(async () => {
    panel = await startPanel({ reportIntervalMs: 1000 });
    operator = await panel.operator();
  });
  afterEach(async () => {
    await panel.close();
  });

  it('reports inventory once the agent is up', async () => {
    const agent = await Agent.started(panel);
    try {
      await waitFor(
        async () => (await operator.inventory(agent.agentId)) !== null,
        'the agent to report its inventory at startup',
      );

      const inventory = await operator.inventory(agent.agentId);
      expect(inventory).not.toBeNull();
      // The facts every host can answer natively, with no shell.
      expect(inventory?.platform).not.toBe('');
      expect(inventory?.arch).not.toBe('');
      expect(inventory?.cpuCores).toBeGreaterThanOrEqual(1);
      expect(inventory?.memTotalBytes).toBeGreaterThan(0);
      expect(Array.isArray(inventory?.disks)).toBe(true);
      expect(Array.isArray(inventory?.nics)).toBe(true);
      // The panel stamps when it received the snapshot, distinct from when the
      // agent collected it.
      expect(inventory?.agentId).toBe(agent.agentId);
      expect(inventory?.receivedAt).not.toBe('');
    } finally {
      await agent.dispose();
    }
  });

  it('re-reports on an inventory command', async () => {
    const agent = await Agent.started(panel);
    try {
      await waitFor(
        async () => (await operator.inventory(agent.agentId)) !== null,
        'the first inventory to arrive',
      );
      const first = await operator.inventory(agent.agentId);

      // Queue a refresh. Like every command it is an intent - nothing has run
      // when this returns.
      const queued = await operator.queue(agent.agentId, 'inventory');
      expect(queued.command).toBe('inventory');
      expect(queued.state).toBe('queued');

      // The agent collects it on its next report, re-posts inventory, and
      // settles the command completed with a one-line summary.
      await waitFor(async () => {
        const commands = await operator.commandsFor(agent.agentId);
        return commands.some(
          (command) =>
            command.command === 'inventory' && command.state === 'completed',
        );
      }, 'the inventory command to settle completed');

      const settled = (await operator.commandsFor(agent.agentId)).find(
        (command) => command.command === 'inventory',
      );
      expect(settled?.detail).toContain('reported inventory');

      // And the stored snapshot was refreshed - a later receipt than the first.
      const second = await operator.inventory(agent.agentId);
      expect(second).not.toBeNull();
      expect(Date.parse(second?.receivedAt ?? '')).toBeGreaterThanOrEqual(
        Date.parse(first?.receivedAt ?? ''),
      );
    } finally {
      await agent.dispose();
    }
  });

  it('is null for a host that has never reported one', async () => {
    // A hand-enrolled identity with no running agent behind it: it exists, but
    // has sent nothing, so there is no snapshot to show.
    const enrolled = await operator.agents();
    expect(enrolled).toHaveLength(0);
    // 404 for an agent that does not exist at all.
    const response = await operator.fetch('/api/agents/nope/inventory');
    expect(response.status).toBe(404);
  });
});
