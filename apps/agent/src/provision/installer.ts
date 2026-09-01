import { Logger } from '@dunx/core';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DeployCredential } from '@dunxon/contract';
import { SERVICE_NAME } from '../config/settings.js';

/** One upload plus one install. Generous: the binary is ~80 MB over a LAN. */
const STEP_TIMEOUT_MS = 180_000;

/**
 * ssh options that make it usable from a service with no terminal. Every one is
 * load bearing: without `BatchMode` a missing key blocks on a password prompt
 * forever, and without a known-hosts policy the first connection to any host
 * blocks on a fingerprint prompt nobody will ever answer.
 *
 * `accept-new` rather than `no`: it still refuses a host whose key has *changed*,
 * which is the case actually worth failing on.
 */
const SSH_OPTIONS = [
  '-o',
  'BatchMode=yes',
  '-o',
  'StrictHostKeyChecking=accept-new',
  '-o',
  'ConnectTimeout=10',
];

export interface InstallTarget {
  readonly address: string;
  readonly credential: DeployCredential;
  /** The URL the *target* can reach the panel on, which cannot be inferred here. */
  readonly panelUrl: string;
  /** What the new agent enrols with - a grant, or the fleet-wide token. */
  readonly enrolmentToken: string;
}

/** What `PropagateService` needs of an installer - the seam a test substitutes. */
export interface Installer {
  isInstalled(
    target: Pick<InstallTarget, 'address' | 'credential'>,
  ): Promise<boolean>;
  install(target: InstallTarget): Promise<string>;
}

/**
 * Copies this binary onto another host and installs it, over SSH.
 *
 * The one place the agent reaches out to a machine that is not the panel, and so
 * the one place credentials for another host are handled. They arrive per call
 * and are gone when it returns: a private key becomes a `0600` file in a temp
 * dir that is removed in a `finally`, and a password is passed to `sshpass`
 * through the environment of the child alone, never `-p` (which would put it in
 * this host's process list for every user to read).
 *
 * Shared by both routes that install onto a neighbour - the panel-brokered
 * `deploy` and the autonomous `propagate` - so the SSH handling has one
 * implementation rather than two that drift.
 */
export class SshInstaller implements Installer {
  /**
   * `binary` is a provider rather than a path because the bytes to install are
   * the panel's published release, not this process's own file. In the compiled
   * binary those are the same thing, but in development `process.execPath` is
   * `bun`, and the panel's copy is version-consistent with what the fleet is
   * meant to be running either way.
   */
  constructor(
    private readonly binary: () => Promise<Uint8Array>,
    private readonly logger: Logger,
  ) {}

  /**
   * Whether the target already runs the agent, asked before installing.
   *
   * `dunxon-agent version` answers for any user and before the container is
   * built, precisely so this question is cheap and cannot false-negative into a
   * reinstall loop. A host that answers is left alone; one that does not, or that
   * cannot be reached, is a candidate.
   */
  async isInstalled(
    target: Omit<InstallTarget, 'panelUrl' | 'enrolmentToken'>,
  ): Promise<boolean> {
    const workspace = mkdtempSync(join(tmpdir(), 'dunxon-probe-'));
    try {
      const auth = this.#authArgs(target.credential, workspace);
      const result = await this.#trySsh(
        target,
        auth,
        `${SERVICE_NAME} version`,
      );
      return result.code === 0 && /\d+\.\d+\.\d+/.test(result.stdout);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  }

  /** Copy the binary over and run its installer. Returns one line of detail. */
  async install(target: InstallTarget): Promise<string> {
    const workspace = mkdtempSync(join(tmpdir(), 'dunxon-install-'));
    try {
      const binary = join(workspace, SERVICE_NAME);
      writeFileSync(binary, await this.binary());
      chmodSync(binary, 0o755);

      const auth = this.#authArgs(target.credential, workspace);
      const env: Record<string, string> =
        target.credential.kind === 'password'
          ? { SSHPASS: target.credential.value }
          : {};
      const remote = `/tmp/${SERVICE_NAME}`;
      const login = `${target.credential.username}@${target.address}`;

      this.logger.info('installing on neighbour', { target: target.address });
      await this.#run(env, [
        ...auth.prefix,
        'scp',
        ...SSH_OPTIONS,
        ...auth.sshArgs,
        '-P',
        String(target.credential.port),
        binary,
        `${login}:${remote}`,
      ]);

      // `sudo -n`, never an interactive prompt: this runs with no terminal, so a
      // host whose sudo wants a password fails loudly rather than hanging.
      const script = [
        `chmod +x ${remote}`,
        `sudo -n ${remote} install --panel-url ${quote(target.panelUrl)} --token ${quote(target.enrolmentToken)}`,
        `rm -f ${remote}`,
      ].join(' && ');

      const output = await this.#run(env, [
        ...auth.prefix,
        'ssh',
        ...SSH_OPTIONS,
        ...auth.sshArgs,
        '-p',
        String(target.credential.port),
        login,
        script,
      ]);

      this.logger.info('installed on neighbour', { target: target.address });
      return `installed on ${target.address}: ${lastLine(output) || 'ok'}`;
    } finally {
      // The credential was on this disk. It does not stay there.
      rmSync(workspace, { recursive: true, force: true });
    }
  }

  #authArgs(
    credential: DeployCredential,
    workspace: string,
  ): { prefix: readonly string[]; sshArgs: readonly string[] } {
    if (credential.kind === 'privateKey') {
      const keyPath = join(workspace, 'id');
      writeFileSync(keyPath, ensureNewline(credential.value));
      // ssh refuses a key any other user can read, and says so unhelpfully.
      chmodSync(keyPath, 0o600);
      return {
        prefix: [],
        sshArgs: ['-i', keyPath, '-o', 'IdentitiesOnly=yes'],
      };
    }
    if (!Bun.which('sshpass')) {
      throw new Error(
        'A password credential needs `sshpass` on this agent, which is not installed. Use a private key, or install sshpass.',
      );
    }
    return { prefix: ['sshpass', '-e'], sshArgs: [] };
  }

  /** A probe ssh that is allowed to fail: absence of the agent is the answer. */
  async #trySsh(
    target: Omit<InstallTarget, 'panelUrl' | 'enrolmentToken'>,
    auth: { prefix: readonly string[]; sshArgs: readonly string[] },
    remoteCommand: string,
  ): Promise<{ code: number; stdout: string }> {
    const env: Record<string, string> =
      target.credential.kind === 'password'
        ? { SSHPASS: target.credential.value }
        : {};
    const [first, ...rest] = [
      ...auth.prefix,
      'ssh',
      ...SSH_OPTIONS,
      ...auth.sshArgs,
      '-p',
      String(target.credential.port),
      `${target.credential.username}@${target.address}`,
      remoteCommand,
    ];
    if (first === undefined) throw new Error('empty command');
    const proc = Bun.spawn([first, ...rest], {
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'ignore',
      timeout: 20_000,
      killSignal: 'SIGKILL',
      env: { ...process.env, ...env },
    });
    const [stdout, code] = await Promise.all([
      new Response(proc.stdout).text(),
      proc.exited,
    ]);
    return { code, stdout };
  }

  async #run(
    env: Record<string, string>,
    command: readonly string[],
  ): Promise<string> {
    const [first, ...rest] = command;
    if (first === undefined) throw new Error('empty command');
    const proc = Bun.spawn([first, ...rest], {
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: STEP_TIMEOUT_MS,
      killSignal: 'SIGKILL',
      env: { ...process.env, ...env },
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (code !== 0) {
      throw new Error(
        `${first} exited ${code}: ${lastLine(stderr) || lastLine(stdout) || 'no output'}`,
      );
    }
    return stdout;
  }
}

const lastLine = (text: string): string =>
  text.trim().split('\n').at(-1)?.trim() ?? '';

const ensureNewline = (text: string): string =>
  text.endsWith('\n') ? text : `${text}\n`;

/** Single quotes, with an embedded quote closed and reopened - POSIX's own idiom. */
const quote = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`;
