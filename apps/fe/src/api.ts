/**
 * The panel's agent API, and the only thing this console talks to. Nothing here
 * knows what a managed host runs; an agent is the unit.
 */
export interface Agent {
  readonly id: string;
  readonly hostname: string;
  readonly agentVersion: string;
  readonly lastSeenAt: string;
  /** Whether the agent is holding a connection right now, not whether it exists. */
  readonly connected: boolean;
}

export type AgentCommand = 'update' | 'restart' | 'report';

/**
 * A command is an intent, not a result. The panel cannot reach an agent, so
 * issuing one queues it until the agent next checks in, and it may expire first.
 *
 * `restart` is never acknowledged the normal way, because the agent dies running
 * it. The panel completes it when the agent reappears with a fresh session.
 */
export type CommandState =
  | 'queued'
  | 'delivered'
  | 'acknowledged'
  | 'completed'
  | 'failed'
  | 'expired';

export interface PendingCommand {
  readonly id: string;
  readonly agentId: string;
  readonly command: AgentCommand;
  readonly state: CommandState;
  readonly queuedAt: string;
  readonly expiresAt: string;
}

const json = async <T>(path: string, init?: RequestInit): Promise<T> => {
  const response = await fetch(path, {
    headers: { 'content-type': 'application/json' },
    ...init,
  });
  if (!response.ok) {
    throw new Error(`${init?.method ?? 'GET'} ${path}: ${response.status}`);
  }
  return (await response.json()) as T;
};

export const listAgents = (): Promise<readonly Agent[]> =>
  json<readonly Agent[]>('/api/agents');

export const listCommands = (): Promise<readonly PendingCommand[]> =>
  json<readonly PendingCommand[]>('/api/agents/commands?state=open');

/** Returns the queued command, not a result: nothing has happened yet. */
export const queueCommand = (
  id: string,
  command: AgentCommand,
): Promise<PendingCommand> =>
  json<PendingCommand>(`/api/agents/${id}/commands`, {
    method: 'POST',
    body: JSON.stringify({ command }),
  });

/**
 * Install onto a host the panel cannot reach, by asking an agent that can. The
 * panel picks the agent from the target's network, so the caller names a target
 * rather than a route to it.
 */
export const queueDeployment = (target: string): Promise<PendingCommand> =>
  json<PendingCommand>('/api/agents/deployments', {
    method: 'POST',
    body: JSON.stringify({ target }),
  });
