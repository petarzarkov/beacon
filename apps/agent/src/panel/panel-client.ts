import { Logger } from '@dunx/core';
import {
  AGENT_HEADER,
  ENROLMENT_HEADER,
  type AgentEventReport,
  type CommandOutcome,
  type DiscoveredHost,
  type EnrolRequest,
  type EnrolResponse,
  type HostReport,
  type ReleaseManifest,
  type ReportResponse,
} from '@beacon/contract';
import { AgentConfigService } from '../config/settings.js';
import { IdentityStore, type Identity } from '../config/identity.js';

export type { ReleaseManifest };

/**
 * Everything that talks to the panel, so nothing else needs a token.
 *
 * The types come from `@beacon/contract`, the shared wire package, rather than
 * being restated here. It imports nothing, which is what lets a compiled binary
 * share it without dragging a DI container into the bundle - and it means a field
 * added to the contract is a type error here rather than a silently dropped value
 * at runtime.
 *
 * **Plain HTTP, and that is the design.** A websocket would give the panel a
 * push channel, but an agent may be at the far end of a link that no proxy will
 * upgrade and no NAT will hold open. What survives everywhere is the agent
 * making a request; so control rides back on the response to a report, and there
 * is nothing to reconnect.
 */
export class PanelClient {
  #identity: Identity | null = null;

  constructor(
    private readonly config: AgentConfigService,
    private readonly store: IdentityStore,
    private readonly logger: Logger,
  ) {}

  /** The enrolled identity, loaded from disk once and cached for the process. */
  identity(): Identity | null {
    this.#identity ??= this.store.load();
    return this.#identity;
  }

  requireIdentity(): Identity {
    const identity = this.identity();
    if (identity === null) {
      throw new Error('This agent has not enrolled yet.');
    }
    return identity;
  }

  #url(path: string): string {
    return new URL(path, `${this.config.requirePanelUrl()}/`).toString();
  }

  async #call<T>(
    path: string,
    init: RequestInit & { readonly headers: Record<string, string> },
  ): Promise<T> {
    const response = await fetch(this.#url(path), {
      ...init,
      // Without a budget a hung panel holds the report loop forever, and the
      // agent stops being able to collect commands at all.
      signal: AbortSignal.timeout(this.config.get('panelTimeoutMs')),
    });
    if (!response.ok) {
      throw new Error(
        `${init.method ?? 'GET'} ${path} -> ${response.status} ${response.statusText}`,
      );
    }
    return (await response.json()) as T;
  }

  #authed(): Record<string, string> {
    return {
      [AGENT_HEADER]: this.requireIdentity().agentToken,
      'content-type': 'application/json',
    };
  }

  /**
   * Exchange the fleet-wide enrolment token for this agent's own.
   *
   * Called once. The result is written to disk before it is used, because a
   * token the panel has issued and the agent has forgotten is unrecoverable -
   * the panel stores only its hash, so it cannot be asked what it was.
   */
  async enrol(request: EnrolRequest): Promise<Identity> {
    const panelUrl = this.config.requirePanelUrl();
    const issued = await this.#call<EnrolResponse>('api/agent/enrol', {
      method: 'POST',
      headers: {
        [ENROLMENT_HEADER]: this.config.requireEnrolmentToken(),
        'content-type': 'application/json',
      },
      body: JSON.stringify(request),
    });

    const identity: Identity = {
      agentId: issued.agentId,
      agentToken: issued.agentToken,
      panelUrl,
      enrolledAt: new Date().toISOString(),
    };
    this.store.save(identity);
    this.#identity = identity;
    this.logger.info('enrolled', { agentId: identity.agentId, panelUrl });
    return identity;
  }

  /** Report, and collect whatever the panel had waiting. */
  report(report: HostReport): Promise<ReportResponse> {
    return this.#call<ReportResponse>('api/agent/report', {
      method: 'POST',
      headers: this.#authed(),
      body: JSON.stringify(report),
    });
  }

  /**
   * Sent after the fact rather than with the next report, so an outcome is not
   * held for a whole interval - an operator watching the console should see a
   * command settle when it settles.
   */
  outcomes(outcomes: readonly CommandOutcome[]): Promise<{ settled: number }> {
    return this.#call<{ settled: number }>('api/agent/outcomes', {
      method: 'POST',
      headers: this.#authed(),
      body: JSON.stringify({ outcomes }),
    });
  }

  /**
   * Lifecycle events, out of band from the report loop. `startup` rides the
   * first moments after enrolment; `exit` is sent as the process is ending, so
   * it cannot wait for a report interval that will not arrive.
   */
  events(events: readonly AgentEventReport[]): Promise<{ recorded: number }> {
    return this.#call<{ recorded: number }>('api/agent/events', {
      method: 'POST',
      headers: this.#authed(),
      body: JSON.stringify({ events }),
    });
  }

  discovered(hosts: readonly DiscoveredHost[]): Promise<{ recorded: number }> {
    return this.#call<{ recorded: number }>('api/agent/discovered', {
      method: 'POST',
      headers: this.#authed(),
      body: JSON.stringify({ hosts }),
    });
  }

  manifest(): Promise<ReleaseManifest> {
    return this.#call<ReleaseManifest>('api/agent/release', {
      headers: { [AGENT_HEADER]: this.requireIdentity().agentToken },
    });
  }

  /** The binary itself. Not `#call`: the body is 80 MB and is not JSON. */
  async download(): Promise<Uint8Array> {
    const response = await fetch(this.#url('api/agent/release/binary'), {
      headers: { [AGENT_HEADER]: this.requireIdentity().agentToken },
      // Deliberately not the per-call budget: this is tens of megabytes, and on
      // a slow link a 20s ceiling would make updating impossible rather than slow.
      signal: AbortSignal.timeout(10 * 60_000),
    });
    if (!response.ok) {
      throw new Error(`Could not download the release: ${response.status}`);
    }
    return new Uint8Array(await response.arrayBuffer());
  }
}
