import {
  closeSync,
  existsSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Panel } from './panel.js';

/**
 * What the agent writes to its identity file, as much of it as the harness reads.
 * Declared here rather than imported from the agent's `src` so the suite reaches
 * into no other package's internals - it asserts on the on-disk contract, which
 * is what a real operator would inspect too.
 */
interface Identity {
  readonly agentId: string;
  readonly agentToken: string;
  readonly panelUrl: string;
}

const REPO_ROOT = resolve(import.meta.dir, '../..');
/**
 * The agent runs with its *own* working directory, not the repo root.
 *
 * `bun` reads `bunfig.toml` from the process's cwd, and only `apps/agent`'s
 * carries the `@dunx/transform` preload that constructor injection needs. Spawn
 * from anywhere else and every provider is built with no arguments and the agent
 * dies at boot - which is also why the compiled binary bakes those records in
 * rather than reading a bunfig at runtime.
 */
const AGENT_DIR = join(REPO_ROOT, 'apps/agent');
const AGENT_ENTRY = join(AGENT_DIR, 'src/main.ts');

export interface AgentOptions {
  /** Names the machine to the panel. Distinct per agent, or they enrol onto one row. */
  readonly machineId?: string;
  /** Overrides the panel's URL, for testing an agent pointed somewhere else. */
  readonly panelUrl?: string;
  /** Overrides the enrolment token, for testing refusal. */
  readonly token?: string;
  readonly extraEnv?: Record<string, string>;
}

/**
 * One agent, as a real process running the real CLI.
 *
 * Spawned rather than constructed in-process, and that is the point of the whole
 * suite. An agent that is imported and called shares this process's environment,
 * its `process.uptime()` and its exit - so the three things most worth testing
 * would all be faked: that `restart` really ends the process, that a fresh
 * process reports a fresh uptime, and that an identity written to disk is found
 * again by a different process.
 */
export class Agent {
  #proc: Bun.Subprocess | null = null;
  readonly stateFile: string;
  readonly machineId: string;
  readonly #dir: string;

  private constructor(
    private readonly panel: Panel,
    private readonly options: AgentOptions,
  ) {
    this.#dir = mkdtempSync(join(tmpdir(), 'dunxon-e2e-agent-'));
    this.stateFile = join(this.#dir, 'identity.json');
    this.machineId = options.machineId ?? `e2e-${crypto.randomUUID()}`;
  }

  static create(panel: Panel, options: AgentOptions = {}): Agent {
    return new Agent(panel, options);
  }

  /** Starts `run` and waits until the panel has an identity for it. */
  static async started(
    panel: Panel,
    options: AgentOptions = {},
  ): Promise<Agent> {
    const agent = Agent.create(panel, options);
    await agent.start();
    return agent;
  }

  get running(): boolean {
    return this.#proc !== null && this.#proc.exitCode === null;
  }

  get logs(): string {
    return existsSync(this.#logPath) ? readFileSync(this.#logPath, 'utf8') : '';
  }

  /** The identity on disk, or null before enrolment. */
  identity(): Identity | null {
    if (!existsSync(this.stateFile)) return null;
    return JSON.parse(readFileSync(this.stateFile, 'utf8')) as Identity;
  }

  get agentId(): string {
    const identity = this.identity();
    if (identity === null) throw new Error('this agent has not enrolled');
    return identity.agentId;
  }

  #env(extra: Record<string, string> = {}): Record<string, string> {
    return {
      ...(process.env as Record<string, string>),
      PANEL_URL: this.options.panelUrl ?? this.panel.url,
      AGENT_TOKEN: this.options.token ?? this.panel.enrolmentToken,
      AGENT_STATE_FILE: this.stateFile,
      AGENT_MACHINE_ID: this.machineId,
      // The panel overrides the cadence anyway; this only covers the window
      // before the first report comes back.
      REPORT_INTERVAL_MS: '1000',
      LOG_LEVEL: process.env['E2E_LOG'] ?? 'info',
      ...this.options.extraEnv,
      ...extra,
    };
  }

  /** `run`, waiting until the identity file exists. */
  async start(waitForEnrolment = true): Promise<void> {
    if (this.running) throw new Error('already running');
    this.#spawn(['run']);
    if (waitForEnrolment) {
      await waitFor(
        () => this.identity() !== null,
        `agent ${this.machineId} never enrolled. Logs:\n${this.logs}`,
      );
    }
  }

  /** A one-shot subcommand (`probe`, `version`, `whoami`, `discover`). */
  async run(
    args: readonly string[],
    env: Record<string, string> = {},
  ): Promise<{ code: number; stdout: string; stderr: string }> {
    const proc = Bun.spawn(['bun', AGENT_ENTRY, ...args], {
      cwd: AGENT_DIR,
      env: this.#env(env),
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { code, stdout, stderr };
  }

  /**
   * Output goes to a file rather than a drained pipe. A long-running agent that
   * fills an undrained pipe blocks on its own logging, and draining a pipe from
   * inside a `bun test` worker proved flaky enough to look like an agent that
   * never started. A file is what journald would be on a real host anyway.
   */
  get #logPath(): string {
    return join(this.#dir, 'agent.log');
  }

  #spawn(args: readonly string[]): void {
    const fd = openSync(this.#logPath, 'a');
    try {
      this.#proc = Bun.spawn(['bun', AGENT_ENTRY, ...args], {
        cwd: AGENT_DIR,
        env: this.#env(),
        stdout: fd,
        stderr: fd,
      });
    } finally {
      // The child holds its own dup of the descriptor; this one has done its job.
      closeSync(fd);
    }
  }

  /** SIGKILL, so nothing gets a chance to shut down cleanly - a host losing power. */
  async kill(): Promise<void> {
    if (this.#proc === null) return;
    this.#proc.kill('SIGKILL');
    await this.#proc.exited;
    this.#proc = null;
  }

  /** SIGTERM, the way `systemctl stop` ends it. */
  async stop(): Promise<void> {
    if (this.#proc === null) return;
    this.#proc.kill('SIGTERM');
    await Promise.race([this.#proc.exited, Bun.sleep(5000)]);
    if (this.#proc.exitCode === null) this.#proc.kill('SIGKILL');
    await this.#proc.exited;
    this.#proc = null;
  }

  /** Waits for the process to end on its own - what `restart` should cause. */
  async waitForExit(timeoutMs = 15_000): Promise<number | null> {
    if (this.#proc === null) return null;
    const proc = this.#proc;
    await Promise.race([proc.exited, Bun.sleep(timeoutMs)]);
    const code = proc.exitCode;
    if (code !== null) this.#proc = null;
    return code;
  }

  /** What systemd's `Restart=always` does: start it again, same state file. */
  async restart(): Promise<void> {
    await this.stop();
    this.#spawn(['run']);
  }

  async dispose(): Promise<void> {
    await this.kill();
    rmSync(this.#dir, { recursive: true, force: true });
  }
}

/** Starts several at once, each with its own identity. */
export const startFleet = async (
  panel: Panel,
  count: number,
): Promise<readonly Agent[]> =>
  Promise.all(
    Array.from({ length: count }, (_, at) =>
      Agent.started(panel, { machineId: `e2e-machine-${at + 1}` }),
    ),
  );

export const disposeFleet = async (agents: readonly Agent[]): Promise<void> => {
  await Promise.all(agents.map((agent) => agent.dispose()));
};

/**
 * Polls until a condition holds. Everything here is eventually consistent by
 * design - the panel learns things when an agent next calls - so a fixed sleep
 * would be either flaky or slow, and usually both.
 */
export const waitFor = async (
  condition: () => boolean | Promise<boolean>,
  describe: string,
  timeoutMs = 20_000,
  everyMs = 100,
): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await condition()) return;
    if (Date.now() > deadline) {
      throw new Error(`Timed out after ${timeoutMs}ms waiting: ${describe}`);
    }
    await Bun.sleep(everyMs);
  }
};
