import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  Agent,
  startPanel,
  waitFor,
  type Operator,
  type Panel,
} from './harness/index.js';

/**
 * Custom commands, against a real agent process.
 *
 * Two tiers, both riding the command→outcome channel: a curated library any
 * operator may run (Tier 1), and free-form execution an admin may run only when
 * the panel enables it (Tier 2). These prove the round trip and the RBAC/gating -
 * the parts that make "run a command on the fleet" safe rather than a back door.
 */
describe('custom commands', () => {
  let panel: Panel;
  let admin: Operator;
  let agent: Agent;

  const startWith = async (allowArbitraryExec = false): Promise<void> => {
    panel = await startPanel({ reportIntervalMs: 1000, allowArbitraryExec });
    admin = await panel.operator();
    agent = await Agent.started(panel);
  };

  afterEach(async () => {
    await agent.dispose();
    await panel.close();
  });

  it('runs a library command (Tier 1) and returns its output', async () => {
    await startWith();
    const entry = await admin.addLibrary({
      name: 'say-hello',
      argv: ['sh', '-c', 'echo hello-from-exec'],
    });

    const queued = await admin.runLibrary(agent.agentId, entry.id);
    expect(queued.command).toBe('exec');
    expect(queued.label).toBe('say-hello');

    await waitFor(async () => {
      const command = (await admin.commandsFor(agent.agentId, 'recent')).find(
        (c) => c.id === queued.id,
      );
      return command?.state === 'completed';
    }, 'the library command to complete');

    const done = (await admin.commandsFor(agent.agentId, 'recent')).find(
      (c) => c.id === queued.id,
    );
    expect(done?.detail).toContain('hello-from-exec');
  });

  it('lets a non-admin run the library but not curate it', async () => {
    await startWith();
    await admin.addLibrary({ name: 'uptime', argv: ['uptime'] });
    const plain = await panel.plainUser();

    // A non-admin can read and run the library...
    const entries = await plain.library();
    expect(entries.length).toBe(1);
    const run = await plain.runLibrary(agent.agentId, entries[0]!.id);
    expect(run.command).toBe('exec');

    // ...but not add to it.
    const denied = await plain.fetch('/api/agents/library', {
      method: 'POST',
      body: JSON.stringify({ name: 'evil', argv: ['rm', '-rf', '/'] }),
    });
    expect(denied.status).toBe(403);
  });

  it('refuses free-form exec (Tier 2) unless the panel enables it', async () => {
    await startWith(false);
    const denied = await admin.fetch(`/api/agents/${agent.agentId}/exec-raw`, {
      method: 'POST',
      body: JSON.stringify({ command: 'echo nope' }),
    });
    expect(denied.status).toBe(403);
  });

  it('runs free-form exec (Tier 2) when enabled, and returns its output', async () => {
    await startWith(true);
    const queued = await admin.runArbitrary(agent.agentId, 'echo free-form-ok');
    expect(queued.label).toBe('echo free-form-ok');

    await waitFor(async () => {
      const command = (await admin.commandsFor(agent.agentId, 'recent')).find(
        (c) => c.id === queued.id,
      );
      return command?.state === 'completed';
    }, 'the free-form command to complete');

    const done = (await admin.commandsFor(agent.agentId, 'recent')).find(
      (c) => c.id === queued.id,
    );
    expect(done?.detail).toContain('free-form-ok');
  });
});
