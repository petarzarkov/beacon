import { afterEach, describe, expect, it } from 'bun:test';
import { AGENT_HEADER, type ReportResponse } from '@beacon/contract';
import { Agent, startPanel, type Panel } from './harness/index.js';

/**
 * The fleet-wide propagation kill switch.
 *
 * Self-propagation needs two keys: a host opting in locally, and the panel being
 * armed. This suite is the panel's key - that it defaults to paused, rides out on
 * every report so a pause reaches the fleet within one interval, and can only be
 * armed by an admin.
 */
describe('the propagation kill switch', () => {
  let panel: Panel;

  afterEach(async () => {
    await panel.close();
  });

  /** Reports once as an enrolled agent and returns the panel's answer. */
  const reportOnce = async (agent: Agent): Promise<ReportResponse> => {
    const token = agent.identity()?.agentToken ?? '';
    const response = await fetch(`${panel.url}/api/agent/report`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [AGENT_HEADER]: token },
      body: JSON.stringify({
        agentVersion: '0.0.0',
        hostname: 'h',
        os: 'linux',
        arch: 'x64',
        uptimeSeconds: 100,
        agentUptimeSeconds: 100,
        load1: 0,
        memTotalBytes: 1,
        memFreeBytes: 1,
        collectedAt: new Date().toISOString(),
      }),
    });
    return (await response.json()) as ReportResponse;
  };

  it('defaults to paused, and says so on every report', async () => {
    panel = await startPanel();
    const agent = await Agent.started(panel);
    try {
      expect((await reportOnce(agent)).propagationAllowed).toBe(false);

      const operator = await panel.operator();
      const settings = await operator.fetch('/api/agents/settings');
      expect(await settings.json()).toEqual({ propagationAllowed: false });
    } finally {
      await agent.dispose();
    }
  });

  it('honours the config seed when set', async () => {
    // The seed only decides the first boot; here it starts armed.
    panel = await startPanel({ propagationAllowed: true });
    const agent = await Agent.started(panel);
    try {
      expect((await reportOnce(agent)).propagationAllowed).toBe(true);
    } finally {
      await agent.dispose();
    }
  });

  it('arms and pauses live, and the change rides out on the next report', async () => {
    panel = await startPanel();
    const agent = await Agent.started(panel);
    try {
      expect((await reportOnce(agent)).propagationAllowed).toBe(false);

      const admin = await panel.operator();
      const armed = await admin.fetch('/api/agents/settings', {
        method: 'PUT',
        body: JSON.stringify({ propagationAllowed: true }),
      });
      expect(armed.status).toBe(200);

      // The next report a real agent makes now carries the armed flag - which is
      // the whole mechanism, since the panel cannot push it.
      expect((await reportOnce(agent)).propagationAllowed).toBe(true);
    } finally {
      await agent.dispose();
    }
  });

  it('refuses to arm for a non-admin operator', async () => {
    panel = await startPanel();
    const user = await panel.plainUser();
    const response = await user.fetch('/api/agents/settings', {
      method: 'PUT',
      body: JSON.stringify({ propagationAllowed: true }),
    });
    // Signed in, but not an admin: the switch is a fleet-wide worm control.
    expect(response.status).toBe(403);

    // And it really did not change - a plain user can still read it.
    const settings = await user.fetch('/api/agents/settings');
    expect(await settings.json()).toEqual({ propagationAllowed: false });
  });
});
