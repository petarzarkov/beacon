import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseQueryResult,
} from '@tanstack/react-query';
import type {
  AgentView,
  CommandView,
  DiscoveryView,
  FleetSettings,
  ReleaseManifest,
} from '@dunxon/contract';
import { http } from './http';
import { keys } from './queryKeys';

export type {
  AgentView,
  CommandView,
  DiscoveryView,
  FleetSettings,
  ReleaseManifest,
};

/**
 * The commands an operator can queue bare. `discover` and `deploy` take an
 * argument, so they have their own calls below.
 */
export type QueueableCommand = 'report' | 'update' | 'restart';

export interface DeployInput {
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
 * Types come from `@dunxon/contract`, the shared wire package - not restated
 * here and not reached out of the server's `src`. The console and the panel
 * agree on what an agent looks like because they read the same file.
 */

/** How often the console re-reads live state. The panel cannot push, so it polls. */
const LIVE_MS = 4000;

export const useAgents = (): UseQueryResult<readonly AgentView[]> =>
  useQuery({
    queryKey: keys.agents,
    queryFn: () => http.get<readonly AgentView[]>('/api/agents'),
    // Until the agent next reports, this is what keeps the table honest about who
    // has gone quiet - `connected` is derived from last-seen on every read.
    refetchInterval: LIVE_MS,
  });

export const useCommands = (
  state: 'open' | 'recent' = 'open',
): UseQueryResult<readonly CommandView[]> =>
  useQuery({
    queryKey: [...keys.commands, state],
    queryFn: () =>
      http.get<readonly CommandView[]>(
        `/api/agents/commands?state=${state}&limit=100`,
      ),
    refetchInterval: LIVE_MS,
  });

export const useDiscovered = (): UseQueryResult<readonly DiscoveryView[]> =>
  useQuery({
    queryKey: keys.discovered,
    queryFn: () => http.get<readonly DiscoveryView[]>('/api/agents/discovered'),
    refetchInterval: LIVE_MS,
  });

export const useRelease = (): UseQueryResult<ReleaseManifest | null> =>
  useQuery({
    queryKey: keys.release,
    queryFn: () => http.get<ReleaseManifest | null>('/api/agents/release'),
  });

/**
 * Queueing a command changes what is outstanding, and nothing about the agent
 * until it checks in - so this invalidates the command list, never the agent
 * list. A green tick for having pressed the button would be a lie the panel
 * cannot back up.
 */
export const useQueueCommand = () => {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, command }: { id: string; command: QueueableCommand }) =>
      http.post<CommandView>(`/api/agents/${id}/commands`, { command }),
    onSuccess: () => client.invalidateQueries({ queryKey: keys.commands }),
  });
};

export const useDiscover = () => {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      http.post<CommandView>(`/api/agents/${id}/discover`, {}),
    onSuccess: () => client.invalidateQueries({ queryKey: keys.commands }),
  });
};

export const useDeploy = () => {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: DeployInput) =>
      http.post<CommandView>('/api/agents/deployments', input),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: keys.commands });
      void client.invalidateQueries({ queryKey: keys.discovered });
    },
  });
};

export const useForgetAgent = () => {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => http.del(`/api/agents/${id}`),
    onSuccess: () => client.invalidateQueries({ queryKey: keys.agents }),
  });
};

export const useFleetSettings = (): UseQueryResult<FleetSettings> =>
  useQuery({
    queryKey: keys.settings,
    queryFn: () => http.get<FleetSettings>('/api/agents/settings'),
    refetchInterval: LIVE_MS,
  });

/**
 * Arm or pause fleet-wide self-propagation. Admin-only server-side; the console
 * only shows the control to an admin, but the guard is what enforces it.
 */
export const useSetPropagation = () => {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (allowed: boolean) =>
      http.put<FleetSettings>('/api/agents/settings', {
        propagationAllowed: allowed,
      }),
    onSuccess: () => client.invalidateQueries({ queryKey: keys.settings }),
  });
};
