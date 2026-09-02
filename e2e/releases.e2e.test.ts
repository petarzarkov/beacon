import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { AGENT_HEADER } from '@beacon/contract';
import { Agent, startPanel, waitFor, type Panel } from './harness/index.js';

/**
 * Release distribution, which is the other half of what the panel is for.
 *
 * The agent verifies a sha256 before it installs anything, so the manifest the
 * panel serves has to describe the bytes exactly. These check that the served
 * manifest and binary agree, that the token gates the download, and that the
 * console can see a newer release is available before an agent has taken it.
 */
describe('releases', () => {
  let panel: Panel;

  afterEach(async () => {
    await panel.close();
  });
  beforeEach(() => {
    // Each test starts its own panel with (or without) a release.
  });

  it('serves a manifest whose hash matches the binary it serves', async () => {
    panel = await startPanel({ release: { version: '0.2.0' } });
    const agent = await Agent.started(panel);
    try {
      const token = agent.identity()?.agentToken ?? '';

      const manifest = (await (
        await fetch(`${panel.url}/api/agent/release`, {
          headers: { [AGENT_HEADER]: token },
        })
      ).json()) as { version: string; sha256: string; sizeBytes: number };
      expect(manifest.version).toBe('0.2.0');

      const bytes = new Uint8Array(
        await (
          await fetch(`${panel.url}/api/agent/release/binary`, {
            headers: { [AGENT_HEADER]: token },
          })
        ).arrayBuffer(),
      );
      const sha256 = new Bun.CryptoHasher('sha256').update(bytes).digest('hex');
      expect(sha256).toBe(manifest.sha256);
      expect(bytes.byteLength).toBe(manifest.sizeBytes);
    } finally {
      await agent.dispose();
    }
  });

  it('will not serve the binary without a valid agent token', async () => {
    panel = await startPanel({ release: { version: '0.2.0' } });
    const response = await fetch(`${panel.url}/api/agent/release/binary`, {
      headers: { [AGENT_HEADER]: 'not-a-token' },
    });
    expect(response.status).toBe(401);
  });

  it('answers 404 for the release when nothing is published', async () => {
    panel = await startPanel({ release: false });
    const agent = await Agent.started(panel);
    try {
      const response = await fetch(`${panel.url}/api/agent/release`, {
        headers: { [AGENT_HEADER]: agent.identity()?.agentToken ?? '' },
      });
      expect(response.status).toBe(404);
    } finally {
      await agent.dispose();
    }
  });

  it('tells the console an agent is behind when a newer release exists', async () => {
    // The agent reports version 0.0.0 (its package version); the panel publishes
    // something newer, so `updateAvailable` must be true for it.
    panel = await startPanel({ release: { version: '9.9.9' } });
    const agent = await Agent.started(panel);
    try {
      const operator = await panel.operator();
      await waitFor(async () => {
        const row = (await operator.agents()).find(
          (a) => a.id === agent.agentId,
        );
        return row?.updateAvailable === true;
      }, 'the agent to be flagged as having an update available');

      const manifest = await operator.release();
      expect(manifest?.version).toBe('9.9.9');
    } finally {
      await agent.dispose();
    }
  });
});
