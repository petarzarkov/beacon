import {
  arch,
  freemem,
  hostname,
  loadavg,
  release,
  totalmem,
  uptime,
} from 'node:os';
import { AgentConfigService } from '../config/settings.js';

/**
 * What one host reports. Small and machine-neutral on purpose: this is the
 * ground floor every managed host can answer.
 *
 * Anything domain-specific belongs in a probe the panel sends rather than baked
 * in here. `landbased-panel` learned that: its agent parses nothing, it runs a
 * script the panel owns and ships the raw stdout, so the panel and the agent
 * cannot disagree about what a field means. Keep that property when this grows.
 */
export interface Report {
  readonly agentVersion: string;
  readonly hostname: string;
  readonly os: string;
  readonly arch: string;
  readonly uptimeSeconds: number;
  readonly load1: number;
  readonly memTotalBytes: number;
  readonly memFreeBytes: number;
  readonly collectedAt: string;
}

export class ProbeService {
  constructor(private readonly config: AgentConfigService) {}

  collect(): Report {
    return {
      agentVersion: this.config.get('version'),
      hostname: hostname(),
      os: release(),
      arch: arch(),
      uptimeSeconds: Math.round(uptime()),
      load1: loadavg()[0] ?? 0,
      memTotalBytes: totalmem(),
      memFreeBytes: freemem(),
      collectedAt: new Date().toISOString(),
    };
  }
}
