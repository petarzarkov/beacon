import { ConfigService, type ConfigSource } from '@dunx/core';
import { z } from 'zod';
import pkg from '../../package.json';

export const AGENT_VERSION: string = pkg.version;

/** Mode `0600`, because it holds the token. Written by `install`. */
export const CONFIG_PATH = '/etc/dunxon-agent/agent.conf';

const schema = z.object({
  PANEL_URL: z.string().url().optional(),
  AGENT_TOKEN: z.string().min(1).optional(),
  /** How often to report when the panel has not said otherwise. */
  REPORT_INTERVAL_MS: z.coerce.number().int().min(1000).default(30_000),
  /** How often to ask whether a newer release is published. */
  UPDATE_INTERVAL_MS: z.coerce
    .number()
    .int()
    .min(60_000)
    .default(6 * 3600_000),
});

export interface AgentConfig {
  readonly version: string;
  readonly panelUrl: string | undefined;
  readonly token: string | undefined;
  readonly reportIntervalMs: number;
  readonly updateIntervalMs: number;
}

/**
 * One name for the typed config everywhere, for the reason the panel's own
 * subclass exists: a factory's `inject: [...]` carries no type argument, and a
 * class is both a precise token and a usable annotation.
 */
export class AgentConfigService extends ConfigService<AgentConfig> {
  /** Throws rather than reporting nowhere, which is the failure worth being loud about. */
  requirePanel(): { panelUrl: string; token: string } {
    const panelUrl = this.get('panelUrl');
    const token = this.get('token');
    if (!panelUrl || !token) {
      throw new Error(
        `No panel URL or token. Pass --panel-url and --token, set PANEL_URL / AGENT_TOKEN, or run \`install\` to write ${CONFIG_PATH}.`,
      );
    }
    return { panelUrl, token };
  }
}

export const validate = (env: ConfigSource): AgentConfig => {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n - ');
    throw new Error(`Agent configuration is invalid:\n - ${issues}`);
  }
  const v = parsed.data;
  return {
    version: AGENT_VERSION,
    panelUrl: v.PANEL_URL,
    token: v.AGENT_TOKEN,
    reportIntervalMs: v.REPORT_INTERVAL_MS,
    updateIntervalMs: v.UPDATE_INTERVAL_MS,
  };
};
