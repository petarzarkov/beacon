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
      collectedAt: new Date().toISOString(),
    };
  }
}
