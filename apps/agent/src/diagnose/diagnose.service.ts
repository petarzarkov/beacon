import { Logger } from '@dunx/core';
import type { DiagnoseProbe } from '@beacon/contract';

/**
 * The read-only diagnostics an operator can run on this host.
 *
 * **An allowlist, not a shell.** Each probe is a fixed command chosen to read
 * host state and change nothing - the panel can already restart this machine, and
 * turning it into a way to run arbitrary commands would be a far larger
 * capability than the one it replaces. The output rides back as the command's
 * outcome, so it appears in the console's command history like any other intent.
 *
 * Each command has a fallback (`ss` or `netstat`, `free` or `/proc/meminfo`), so
 * a probe still answers on a minimal host rather than failing for a missing tool.
 */
const PROBES: Record<DiagnoseProbe, readonly string[]> = {
  disk: ['df', '-h'],
  memory: ['sh', '-c', 'free -h 2>/dev/null || head -n 6 /proc/meminfo'],
  processes: [
    'sh',
    '-c',
    'ps -eo pid,pcpu,pmem,rss,comm --sort=-pmem 2>/dev/null | head -n 16',
  ],
  network: [
    'sh',
    '-c',
    'ss -tuln 2>/dev/null || netstat -tuln 2>/dev/null || echo "no ss/netstat available"',
  ],
  uptime: ['uptime'],
};

/** Output ceiling, under the panel's per-outcome cap so the result is never rejected. */
const MAX_OUTPUT = 7_000;

export class DiagnoseService {
  constructor(private readonly logger: Logger) {}

  /** Run one probe and return its output, trimmed and bounded. Never throws. */
  run(probe: DiagnoseProbe): string {
    const argv = PROBES[probe];
    this.logger.info('running diagnostic', { probe });
    try {
      const result = Bun.spawnSync([...argv], {
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const decode = (buf: Uint8Array): string => new TextDecoder().decode(buf);
      const output = `${decode(result.stdout)}${decode(result.stderr)}`.trim();
      if (output === '') {
        return result.success
          ? '(no output)'
          : `${probe} produced nothing (exit ${result.exitCode})`;
      }
      return output.length > MAX_OUTPUT
        ? `${output.slice(0, MAX_OUTPUT)}\n… (truncated)`
        : output;
    } catch (error) {
      return `could not run ${probe}: ${error instanceof Error ? error.message : String(error)}`;
    }
  }
}
