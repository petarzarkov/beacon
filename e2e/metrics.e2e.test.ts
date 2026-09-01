import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  Agent,
  startPanel,
  waitFor,
  type Operator,
  type Panel,
} from './harness/index.js';

/**
 * Metric history, against a real agent process.
 *
 * The last report is a snapshot; this is the series behind it. The panel appends
 * a point per report, so a running agent accumulates a trend the console can
 * chart - memory and, once there are two samples to rate against, CPU.
 */
describe('agent metrics history', () => {
  let panel: Panel;
  let operator: Operator;

  beforeEach(async () => {
    panel = await startPanel({ reportIntervalMs: 1000 });
    operator = await panel.operator();
  });
  afterEach(async () => {
    await panel.close();
  });

  it('accumulates a point per report, with the agent’s own memory and CPU', async () => {
    const agent = await Agent.started(panel);
    try {
      // Wait for enough reports that CPU has a baseline to rate against.
      await waitFor(async () => {
        const points = await operator.metrics(agent.agentId);
        return points.length >= 3;
      }, 'at least three metric samples');

      const points = await operator.metrics(agent.agentId);
      // Oldest first, so a chart reads left to right.
      const times = points.map((p) => Date.parse(p.at));
      expect(times).toEqual([...times].sort((a, b) => a - b));

      // The agent's own footprint, present on every point.
      expect(points.every((p) => p.memBytes > 0)).toBe(true);
      // CPU is null on the first point (no baseline) and a real number later.
      expect(points.some((p) => p.cpuPercent !== null)).toBe(true);
    } finally {
      await agent.dispose();
    }
  });

  it('404s metrics for an agent that does not exist', async () => {
    const response = await operator.fetch('/api/agents/nope/metrics');
    expect(response.status).toBe(404);
  });
});
