import {
  arch,
  freemem,
  hostname,
  loadavg,
  release,
  totalmem,
  uptime,
} from 'node:os';
import type { HostReport } from '@dunxon/contract';
import { AgentConfigService } from '../config/settings.js';

export type { HostReport };

/**
 * What one host reports. Small and machine-neutral on purpose: this is the
 * ground floor every managed host can answer.
 *
 * Anything domain-specific belongs in a probe the panel sends rather than baked
 * in here. `landbased-panel` learned that: its agent parses nothing, it runs a
 * script the panel owns and ships the raw stdout, so the panel and the agent
 * cannot disagree about what a field means. Keep that property when this grows.
 */
export class ProbeService {
  constructor(private readonly config: AgentConfigService) {}

  /**
   * The previous CPU sample, so a report can express usage as a rate. A rate
   * needs two points, so the first `collect()` returns null and only records the
   * baseline; every one after diffs against the last. Held on the service, which
   * lives for the whole `run` process, so the sampling spans the report loop.
   */
  #lastCpu: { at: number; usage: NodeJS.CpuUsage } | null = null;

  collect(): HostReport {
    return {
      agentVersion: this.config.get('version'),
      hostname: hostname(),
      os: release(),
      arch: arch(),
      uptimeSeconds: Math.round(uptime()),
      /**
       * The process's own age, and the reason `restart` is observable at all.
       *
       * Host uptime cannot answer it - restarting a service does not reboot the
       * machine - so without this the panel would have no way to tell an agent
       * that obeyed a restart from one that ignored it, and every restart would
       * sit `delivered` until its TTL ran out.
       */
      agentUptimeSeconds: Math.round(process.uptime()),
      load1: loadavg()[0] ?? 0,
      memTotalBytes: totalmem(),
      memFreeBytes: freemem(),
      // The agent's own footprint, which is what an operator actually wants of a
      // fleet of agents - the host totals above are the machine, not this process.
      agentMemBytes: process.memoryUsage().rss,
      agentCpuPercent: this.#cpuPercent(),
      collectedAt: new Date().toISOString(),
    };
  }

  /**
   * The agent process's CPU since the last sample, as a percent of one core.
   *
   * `process.cpuUsage()` is cumulative microseconds, so the rate is the delta
   * over the wall-clock delta. Null on the first call: there is nothing to
   * difference against yet, and reporting 0 would be a claim rather than an
   * absence.
   */
  #cpuPercent(): number | null {
    const at = performance.now();
    const usage = process.cpuUsage();
    const previous = this.#lastCpu;
    this.#lastCpu = { at, usage };
    if (previous === null) return null;

    const wallMs = at - previous.at;
    if (wallMs <= 0) return null;
    const cpuMs =
      (usage.user -
        previous.usage.user +
        (usage.system - previous.usage.system)) /
      1000;
    return Math.round((cpuMs / wallMs) * 1000) / 10;
  }
}
