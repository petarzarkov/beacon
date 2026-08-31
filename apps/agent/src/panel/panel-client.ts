import { Logger } from '@dunx/core';
import { AgentConfigService } from '../config/settings.js';
import type { Report } from '../probe/probe.service.js';

/** What the panel publishes beside the binary, and what an update verifies against. */
export interface ReleaseManifest {
  readonly version: string;
  readonly sha256: string;
  readonly sizeBytes: number;
  readonly file: string;
  readonly builtAt: string;
}

/**
 * Everything that talks to the panel, so nothing else needs the token.
 *
 * HTTP for now. A websocket is the destination, because it gives the panel a
 * push channel and "update now" then costs nothing to deliver; this shape keeps
 * that a change of transport rather than a change of caller.
 */
export class PanelClient {
  constructor(
    private readonly config: AgentConfigService,
    private readonly logger: Logger,
  ) {}

  #headers(): Record<string, string> {
    const { token } = this.config.requirePanel();
    return { 'x-agent-token': token, 'content-type': 'application/json' };
  }

  #url(path: string): string {
    const { panelUrl } = this.config.requirePanel();
    return new URL(path, panelUrl).toString();
  }

  async report(report: Report): Promise<void> {
    const response = await fetch(this.#url('/api/agents/report'), {
      method: 'POST',
      headers: this.#headers(),
      body: JSON.stringify(report),
    });
    if (!response.ok) {
      throw new Error(`Panel rejected the report: ${response.status}`);
    }
    this.logger.info('reported', { host: report.hostname });
  }

  async manifest(): Promise<ReleaseManifest> {
    const response = await fetch(this.#url('/api/agents/release'), {
      headers: this.#headers(),
    });
    if (!response.ok) {
      throw new Error(`No published release: ${response.status}`);
    }
    return (await response.json()) as ReleaseManifest;
  }

  async download(): Promise<Uint8Array> {
    const response = await fetch(this.#url('/api/agents/release/binary'), {
      headers: this.#headers(),
    });
    if (!response.ok) {
      throw new Error(`Could not download the release: ${response.status}`);
    }
    return new Uint8Array(await response.arrayBuffer());
  }
}
