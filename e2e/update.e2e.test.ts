import { afterEach, describe, expect, it } from 'bun:test';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { MANIFEST_FILE } from '@beacon/contract';
import { Agent, startPanel, waitFor, type Panel } from './harness/index.js';

/**
 * Self-update, end to end and for real.
 *
 * This is the one path the rest of the suite could only test the edges of: the
 * releases suite proves the panel serves a manifest and binary whose hashes
 * agree, but not that an agent given one will verify it, swap its own binary out
 * atomically, and come back running the new one. That swap is the whole reason
 * the panel is a release host, and until now nothing exercised it - it renames a
 * file over `/usr/local/bin/beacon-agent` and restarts through systemd, neither
 * of which a test can own.
 *
 * So the agent takes both from config: `AGENT_INSTALL_PATH` points the swap at a
 * temp file this suite does own, and `AGENT_RESTART_COMMAND` records the restart
 * a runner has no systemd to perform. Both default to the production values and
 * are unset on a real host; here they are what let the real `UpdateService` run
 * against a real panel. The bytes swapped in are a stand-in - `run()` verifies a
 * sha256 and renames, and does not care what the binary is - so these assert the
 * mechanism without an 80 MB build per case.
 */
describe('self-update', () => {
  let panel: Panel;
  let workspace: string;

  afterEach(async () => {
    await panel.close();
    if (workspace !== undefined) {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  /** A temp install target, a restart recorder, and a v1 binary already in place. */
  const stage = (): {
    installPath: string;
    restartScript: string;
    restartMarker: string;
    installed: () => string;
    restarted: () => boolean;
  } => {
    workspace = mkdtempSync(join(tmpdir(), 'beacon-e2e-update-'));
    const installPath = join(workspace, 'beacon-agent');
    const restartMarker = join(workspace, 'restarted');
    const restartScript = join(workspace, 'restart.sh');

    // The binary the swap replaces: a runnable stand-in reporting the old version.
    writeFileSync(installPath, '#!/bin/sh\necho v1-in-place\n');
    chmodSync(installPath, 0o755);

    writeFileSync(
      restartScript,
      `#!/bin/sh\necho restarted > ${restartMarker}\n`,
    );
    chmodSync(restartScript, 0o755);

    return {
      installPath,
      restartScript,
      restartMarker,
      installed: () => readFileSync(installPath, 'utf8'),
      restarted: () => existsSync(restartMarker),
    };
  };

  const sha256 = (path: string): string =>
    new Bun.CryptoHasher('sha256')
      .update(new Uint8Array(readFileSync(path)))
      .digest('hex');

  /**
   * The root timer's job: `beacon-agent update` verifies the published hash,
   * swaps the binary in place, and restarts. Driven here as the CLI does it,
   * because that is exactly what the update unit's `ExecStart` runs.
   */
  it('verifies, swaps the binary in place, and restarts', async () => {
    panel = await startPanel({ release: { version: '9.9.9' } });
    const target = stage();

    const agent = await Agent.started(panel);
    await agent.stop(); // enrolled; the identity on disk is all `update` needs.
    try {
      const result = await agent.run(['update'], {
        AGENT_INSTALL_PATH: target.installPath,
        AGENT_RESTART_COMMAND: target.restartScript,
      });
      expect(result.code).toBe(0);

      // The binary on disk is now exactly the one the panel published.
      expect(sha256(target.installPath)).toBe(panel.manifest!.sha256);
      // ...and it is the new binary, runnable, reporting the new version.
      expect(target.installed()).toContain('9.9.9');
      // Nothing half-written is left where systemd would restart it.
      expect(existsSync(`${target.installPath}.next`)).toBe(false);
      // The restart the update owes actually fired.
      expect(target.restarted()).toBe(true);
    } finally {
      await agent.dispose();
    }
  });

  it('refuses a binary whose hash does not match, and leaves the old one', async () => {
    panel = await startPanel({ release: { version: '9.9.9' } });
    const target = stage();

    // Corrupt the published hash after the fact: the bytes the panel serves no
    // longer match what its manifest claims, which is the exact shape of a
    // tampered or truncated release the check exists to catch.
    const manifestPath = join(panel.releaseDir, MANIFEST_FILE);
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    manifest.sha256 = '0'.repeat(64);
    writeFileSync(manifestPath, JSON.stringify(manifest));

    const agent = await Agent.started(panel);
    await agent.stop();
    try {
      const result = await agent.run(['update'], {
        AGENT_INSTALL_PATH: target.installPath,
        AGENT_RESTART_COMMAND: target.restartScript,
      });
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('does not match');

      // The one binary managing the host is untouched, and nothing restarted.
      expect(target.installed()).toContain('v1-in-place');
      expect(existsSync(`${target.installPath}.next`)).toBe(false);
      expect(target.restarted()).toBe(false);
    } finally {
      await agent.dispose();
    }
  });

  it('does nothing when already on the published version', async () => {
    // The agent reports its package version (0.0.0); publish the same, so there
    // is nothing newer and the swap must not run.
    panel = await startPanel({ release: { version: '0.0.0' } });
    const target = stage();

    const agent = await Agent.started(panel);
    await agent.stop();
    try {
      const result = await agent.run(['update'], {
        AGENT_INSTALL_PATH: target.installPath,
        AGENT_RESTART_COMMAND: target.restartScript,
      });
      expect(result.code).toBe(0);
      expect(target.installed()).toContain('v1-in-place');
      expect(target.restarted()).toBe(false);
    } finally {
      await agent.dispose();
    }
  });

  /**
   * The operator-driven path, whole. An operator queues `update`; the running,
   * unprivileged service collects it and - because it cannot write its own binary
   * by design - asks the root updater to. In production that ask is
   * `sudo systemctl start beacon-agent-update.service`; here it is the same swap
   * that unit would run, so the flow from a console button to a swapped binary is
   * proven rather than assumed.
   */
  it('swaps the binary when an operator queues update', async () => {
    panel = await startPanel({
      release: { version: '9.9.9' },
      reportIntervalMs: 1000,
    });
    const target = stage();

    // What the unprivileged service runs in place of the systemd trigger: the
    // real swap, in the agent dir so its DI preload is found.
    const agentDir = resolve(import.meta.dir, '../apps/agent');
    const trigger = join(workspace, 'trigger.sh');
    writeFileSync(
      trigger,
      `#!/bin/sh\ncd ${agentDir}\nexec bun ${join(agentDir, 'src/main.ts')} update\n`,
    );
    chmodSync(trigger, 0o755);

    const agent = await Agent.started(panel, {
      extraEnv: {
        AGENT_INSTALL_PATH: target.installPath,
        AGENT_RESTART_COMMAND: target.restartScript,
        AGENT_UPDATE_TRIGGER_COMMAND: trigger,
      },
    });
    const operator = await panel.operator();
    try {
      const queued = await operator.queue(agent.agentId, 'update');

      await waitFor(async () => {
        const command = (
          await operator.commandsFor(agent.agentId, 'recent')
        ).find((c) => c.id === queued.id);
        return command?.state === 'completed';
      }, 'the queued update to settle');

      // The binary the service would be restarted onto is now the published one.
      await waitFor(
        () =>
          existsSync(target.installPath) &&
          sha256(target.installPath) === panel.manifest?.sha256,
        'the queued update to swap the binary in place',
      );
      expect(target.installed()).toContain('9.9.9');
      expect(target.restarted()).toBe(true);
    } finally {
      await agent.dispose();
    }
  });
});
