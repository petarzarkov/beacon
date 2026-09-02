import { Logger } from '@dunx/core';

/** Under the panel's per-outcome cap, so the result is never rejected for size. */
const MAX_OUTPUT = 7_000;
/** A command that runs longer than this is killed - it must not stall the report loop. */
const TIMEOUT_MS = 60_000;

/**
 * Runs a resolved command and returns its output, for the `exec` command.
 *
 * Unlike diagnostics, an exec can change the host - so it is gated on the panel
 * side (a curated library, or an admin with a flag set), and the agent only ever
 * receives an already-resolved argv. It runs as **this process's own service
 * user**, which is unprivileged by design, so what an exec can do is bounded by
 * that user and not by root. Output is combined, bounded and never thrown.
 */
export class ExecService {
  constructor(private readonly logger: Logger) {}

  run(argv: readonly string[]): string {
    if (argv.length === 0) return 'exec: empty command';
    this.logger.info('running exec', { argv });
    try {
      const result = Bun.spawnSync([...argv], {
        stdout: 'pipe',
        stderr: 'pipe',
        timeout: TIMEOUT_MS,
        killSignal: 'SIGKILL',
      });
      const decode = (buf: Uint8Array): string => new TextDecoder().decode(buf);
      const output = `${decode(result.stdout)}${decode(result.stderr)}`.trim();
      const status = result.success ? '' : `\n(exit ${result.exitCode})`;
      const body = (output === '' ? '(no output)' : output) + status;
      return body.length > MAX_OUTPUT
        ? `${body.slice(0, MAX_OUTPUT)}\n… (truncated)`
        : body;
    } catch (error) {
      return `could not run the command: ${error instanceof Error ? error.message : String(error)}`;
    }
  }
}
