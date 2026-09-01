import type {
  AgentEventView,
  AgentMetricPoint,
  AgentView,
  CommandView,
  DiagnoseProbe,
  DiscoveryView,
  ReleaseManifest,
} from '@dunxon/contract';

export type {
  AgentEventView,
  AgentMetricPoint,
  AgentView,
  CommandView,
  DiscoveryView,
};

export interface DeployRequest {
  readonly target: string;
  readonly credential: {
    readonly kind: 'password' | 'privateKey';
    readonly username: string;
    readonly value: string;
    readonly port?: number;
  };
  readonly panelUrl: string;
  readonly ttlMinutes?: number;
}

/**
 * The console, as a client.
 *
 * A signed-in session with a cookie, exactly as a browser holds one - not a
 * bearer token and not a back door. What the suite exercises is therefore the
 * same path the console takes, including `SessionGuard`, so a change that breaks
 * the browser breaks these tests too.
 */
export class Operator {
  private constructor(
    private readonly base: string,
    private readonly cookie: string,
  ) {}

  static async signIn(
    base: string,
    email: string,
    password: string,
  ): Promise<Operator> {
    const response = await fetch(`${base}/api/auth/sign-in/email`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    if (!response.ok) {
      throw new Error(
        `sign-in failed: ${response.status} ${await response.text()}`,
      );
    }
    const cookie = response.headers.getSetCookie().join('; ');
    if (cookie === '') throw new Error('sign-in returned no session cookie');
    return new Operator(base, cookie);
  }

  /** The raw response, for tests that assert on status rather than on a body. */
  fetch(path: string, init: RequestInit = {}): Promise<Response> {
    // `Headers`, not a spread: `init.headers` may be an array of pairs or a
    // `Headers`, neither of which spreads into an object correctly.
    const headers = new Headers(init.headers);
    headers.set('cookie', this.cookie);
    if (!headers.has('content-type')) {
      headers.set('content-type', 'application/json');
    }
    return fetch(`${this.base}${path}`, { ...init, headers });
  }

  async #json<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await this.fetch(path, init);
    if (!response.ok) {
      throw new Error(
        `${init.method ?? 'GET'} ${path} -> ${response.status} ${await response.text()}`,
      );
    }
    return (await response.json()) as T;
  }

  agents(): Promise<readonly AgentView[]> {
    return this.#json<readonly AgentView[]>('/api/agents');
  }

  agent(id: string): Promise<AgentView> {
    return this.#json<AgentView>(`/api/agents/${id}`);
  }

  events(id: string, limit = 50): Promise<readonly AgentEventView[]> {
    return this.#json<readonly AgentEventView[]>(
      `/api/agents/${id}/events?limit=${limit}`,
    );
  }

  metrics(id: string, minutes = 60): Promise<readonly AgentMetricPoint[]> {
    return this.#json<readonly AgentMetricPoint[]>(
      `/api/agents/${id}/metrics?minutes=${minutes}`,
    );
  }

  commands(
    state: 'open' | 'recent' = 'open',
    limit = 50,
  ): Promise<readonly CommandView[]> {
    return this.#json<readonly CommandView[]>(
      `/api/agents/commands?state=${state}&limit=${limit}`,
    );
  }

  queue(
    agentId: string,
    command: 'report' | 'update' | 'restart',
  ): Promise<CommandView> {
    return this.#json<CommandView>(`/api/agents/${agentId}/commands`, {
      method: 'POST',
      body: JSON.stringify({ command }),
    });
  }

  discover(
    agentId: string,
    body: { cidr?: string; ports?: number[] } = {},
  ): Promise<CommandView> {
    return this.#json<CommandView>(`/api/agents/${agentId}/discover`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
  }

  diagnose(agentId: string, probe: DiagnoseProbe): Promise<CommandView> {
    return this.#json<CommandView>(`/api/agents/${agentId}/diagnose`, {
      method: 'POST',
      body: JSON.stringify({ probe }),
    });
  }

  discovered(): Promise<readonly DiscoveryView[]> {
    return this.#json<readonly DiscoveryView[]>('/api/agents/discovered');
  }

  deploy(request: DeployRequest): Promise<CommandView> {
    return this.#json<CommandView>('/api/agents/deployments', {
      method: 'POST',
      body: JSON.stringify(request),
    });
  }

  release(): Promise<ReleaseManifest | null> {
    return this.#json<ReleaseManifest | null>('/api/agents/release');
  }

  remove(agentId: string): Promise<{ deleted: true }> {
    return this.#json<{ deleted: true }>(`/api/agents/${agentId}`, {
      method: 'DELETE',
    });
  }

  /** Runs the TTL sweep now, rather than waiting out the panel's own interval. */
  expire(): Promise<{ expired: number }> {
    return this.#json<{ expired: number }>('/api/agents/commands/expire', {
      method: 'POST',
    });
  }

  /** The command rows for one agent, which the fleet-wide list does not filter. */
  async commandsFor(
    agentId: string,
    state: 'open' | 'recent' = 'recent',
  ): Promise<readonly CommandView[]> {
    const all = await this.commands(state, 200);
    return all.filter((command) => command.agentId === agentId);
  }
}
