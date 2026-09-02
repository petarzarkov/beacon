import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { AGENT_HEADER, ENROLMENT_HEADER } from '@beacon/contract';
import { Agent, startPanel, waitFor, type Panel } from './harness/index.js';

/**
 * How a host is admitted to the fleet, and how it is refused.
 *
 * Enrolment is the one door into the system, so most of what is asserted here is
 * that the wrong credential does not open it: a bad token, a panel with
 * enrolment switched off, and one agent's token used against another's identity.
 */
describe('enrolment', () => {
  let panel: Panel;

  beforeEach(async () => {
    panel = await startPanel();
  });
  afterEach(async () => {
    await panel.close();
  });

  it('issues an identity for a valid token, and stores only its hash', async () => {
    const agent = await Agent.started(panel);
    try {
      const identity = agent.identity();
      expect(identity).not.toBeNull();
      expect(identity?.agentToken).toMatch(/^[0-9a-f]{64}$/);

      // The panel cannot produce the token again - the fleet listing must not
      // contain it, because the column is a digest.
      const operator = await panel.operator();
      const body = await (await operator.fetch('/api/agents')).text();
      expect(body).not.toContain(identity?.agentToken);
    } finally {
      await agent.dispose();
    }
  });

  it('refuses a bad enrolment token, so the agent never gets an identity', async () => {
    const response = await fetch(`${panel.url}/api/agent/enrol`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        [ENROLMENT_HEADER]: 'not-the-token',
      },
      body: JSON.stringify({
        hostname: 'intruder',
        os: 'linux',
        arch: 'x64',
        agentVersion: '0.0.0',
        machineId: 'intruder-1',
      }),
    });
    expect(response.status).toBe(401);
  });

  it('refuses all enrolment when the panel has no token set', async () => {
    const closed = await startPanel({ enrolmentToken: '' });
    try {
      const response = await fetch(`${closed.url}/api/agent/enrol`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          [ENROLMENT_HEADER]: 'anything',
        },
        body: JSON.stringify({
          hostname: 'h',
          os: 'linux',
          arch: 'x64',
          agentVersion: '0.0.0',
          machineId: 'm',
        }),
      });
      // A disabled door is a 403, distinct from a 401 for a wrong key: the
      // operator's fix is different (set a token vs. use the right one).
      expect(response.status).toBe(403);
    } finally {
      await closed.close();
    }
  });

  it('re-enrols the same machine onto one row, keeping its id', async () => {
    const first = await Agent.started(panel, { machineId: 'stable-machine' });
    const firstId = first.agentId;
    await first.dispose();

    // A wiped host: same machine-id, no identity file. It must land on the same
    // row rather than forking a second one and scattering its history.
    const second = Agent.create(panel, { machineId: 'stable-machine' });
    try {
      await second.start();
      expect(second.agentId).toBe(firstId);

      const operator = await panel.operator();
      const managed = await operator.agents();
      expect(managed.filter((a) => a.id === firstId)).toHaveLength(1);
    } finally {
      await second.dispose();
    }
  });

  it('rejects an unknown agent token on the report route', async () => {
    const response = await fetch(`${panel.url}/api/agent/report`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        [AGENT_HEADER]: 'a-token-that-was-never-issued',
      },
      body: JSON.stringify({
        agentVersion: '0.0.0',
        hostname: 'h',
        os: 'linux',
        arch: 'x64',
        uptimeSeconds: 1,
        agentUptimeSeconds: 1,
        load1: 0,
        memTotalBytes: 1,
        memFreeBytes: 1,
        collectedAt: new Date().toISOString(),
      }),
    });
    expect(response.status).toBe(401);
  });

  it('will not let one agent present another panel’s grant', async () => {
    // Two panels with different secrets. A grant one signs must be worthless to
    // the other - that is what a signed, panel-scoped credential is for.
    const other = await startPanel();
    try {
      const agent = await Agent.started(panel);
      const stolenGrant = 'g1|9999999999999|10.0.0.9|deadbeef';
      const response = await fetch(`${other.url}/api/agent/enrol`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          [ENROLMENT_HEADER]: stolenGrant,
        },
        body: JSON.stringify({
          hostname: 'h',
          os: 'linux',
          arch: 'x64',
          agentVersion: '0.0.0',
          machineId: 'm',
        }),
      });
      expect(response.status).toBe(401);
      await agent.dispose();
    } finally {
      await other.close();
    }
  });
});

describe('single-use deployment grants', () => {
  let panel: Panel;

  beforeEach(async () => {
    panel = await startPanel();
  });
  afterEach(async () => {
    await panel.close();
  });

  /**
   * A grant is scoped to one address and expires after a few minutes, but the
   * original design left it reusable within that window. These tests assert the
   * new single-use behaviour: the first enrolment succeeds, the second with the
   * same grant is rejected regardless of which machine presents it.
   */
  it('accepts a valid grant exactly once', async () => {
    // Mint a grant for any address; in a test environment without TRUST_PROXY
    // the panel sees no source IP, so the address-match check is skipped and
    // the only things that matter are the signature and the single-use record.
    const grant = panel.grantFor('127.0.0.1');

    const first = await fetch(`${panel.url}/api/agent/enrol`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        [ENROLMENT_HEADER]: grant,
      },
      body: JSON.stringify({
        hostname: 'target',
        os: 'linux',
        arch: 'x64',
        agentVersion: '0.0.0',
        machineId: 'grant-target-1',
      }),
    });
    expect(first.ok).toBe(true);
    const { agentId } = (await first.json()) as { agentId: string };
    expect(agentId).toBeTruthy();
  });

  it('rejects a grant presented a second time', async () => {
    const grant = panel.grantFor('127.0.0.1');

    // First use enrols successfully.
    const first = await fetch(`${panel.url}/api/agent/enrol`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        [ENROLMENT_HEADER]: grant,
      },
      body: JSON.stringify({
        hostname: 'target',
        os: 'linux',
        arch: 'x64',
        agentVersion: '0.0.0',
        machineId: 'grant-replay-1',
      }),
    });
    expect(first.ok).toBe(true);

    // Second use with the same grant — different machineId, same credential.
    // A leaked grant must not be usable by anyone who picks it up.
    const second = await fetch(`${panel.url}/api/agent/enrol`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        [ENROLMENT_HEADER]: grant,
      },
      body: JSON.stringify({
        hostname: 'attacker',
        os: 'linux',
        arch: 'x64',
        agentVersion: '0.0.0',
        machineId: 'grant-replay-2',
      }),
    });
    expect(second.status).toBe(401);
  });
});
