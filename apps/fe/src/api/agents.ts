import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseQueryResult,
} from '@tanstack/react-query';
import type {
  AgentEventView,
  AgentMetricPoint,
  AgentView,
  AlertRuleView,
  AlertView,
  CommandLibraryEntry,
  CommandView,
  DiagnoseProbe,
  DiscoveryView,
  FleetSettings,
  ReleaseManifest,
} from '@beacon/contract';
import { http } from './http';
import { keys } from './queryKeys';

export type {
  AgentEventView,
  AgentMetricPoint,
  AgentView,
  AlertRuleView,
  AlertView,
  CommandLibraryEntry,
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
 * Types come from `@beacon/contract`, the shared wire package - not restated
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

/** One agent, for the detail page. Same live cadence as the fleet list. */
export const useAgent = (id: string): UseQueryResult<AgentView> =>
  useQuery({
    queryKey: [...keys.agents, id],
    queryFn: () => http.get<AgentView>(`/api/agents/${id}`),
    refetchInterval: LIVE_MS,
  });

/** One agent's lifecycle events (startup, exit), newest first, live. */
export const useAgentEvents = (
  id: string,
): UseQueryResult<readonly AgentEventView[]> =>
  useQuery({
    queryKey: [...keys.agents, id, 'events'],
    queryFn: () =>
      http.get<readonly AgentEventView[]>(`/api/agents/${id}/events?limit=50`),
    refetchInterval: LIVE_MS,
  });

/** One agent's metric history over the last `minutes`, oldest first, live. */
export const useAgentMetrics = (
  id: string,
  minutes: number,
): UseQueryResult<readonly AgentMetricPoint[]> =>
  useQuery({
    queryKey: [...keys.agents, id, 'metrics', minutes],
    queryFn: () =>
      http.get<readonly AgentMetricPoint[]>(
        `/api/agents/${id}/metrics?minutes=${minutes}`,
      ),
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

/** Queue a read-only diagnostic. The output arrives as the command's outcome. */
export const useDiagnose = () => {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, probe }: { id: string; probe: DiagnoseProbe }) =>
      http.post<CommandView>(`/api/agents/${id}/diagnose`, { probe }),
    onSuccess: () => client.invalidateQueries({ queryKey: keys.commands }),
  });
};

/** The admin-curated command library (Tier 1). Any operator may read it. */
export const useCommandLibrary = (): UseQueryResult<
  readonly CommandLibraryEntry[]
> =>
  useQuery({
    queryKey: keys.library,
    queryFn: () =>
      http.get<readonly CommandLibraryEntry[]>('/api/agents/library'),
  });

export const useAddLibraryEntry = () => {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (entry: {
      name: string;
      description?: string;
      argv: string[];
    }) => http.post<CommandLibraryEntry>('/api/agents/library', entry),
    onSuccess: () => client.invalidateQueries({ queryKey: keys.library }),
  });
};

export const useDeleteLibraryEntry = () => {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => http.del(`/api/agents/library/${id}`),
    onSuccess: () => client.invalidateQueries({ queryKey: keys.library }),
  });
};

/** Tier 1: run a library command by id on an agent. */
export const useRunLibrary = () => {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, libraryId }: { id: string; libraryId: string }) =>
      http.post<CommandView>(`/api/agents/${id}/exec`, { libraryId }),
    onSuccess: () => client.invalidateQueries({ queryKey: keys.commands }),
  });
};

/** Tier 2: run a free-form command on an agent (admin, gated). */
export const useRunArbitrary = () => {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, command }: { id: string; command: string }) =>
      http.post<CommandView>(`/api/agents/${id}/exec-raw`, { command }),
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

// --- Alerting ----------------------------------------------------------------

/** What a new alert rule looks like from the console. */
export interface NewAlertRule {
  readonly name: string;
  readonly kind: AlertRuleView['kind'];
  readonly metric?: AlertRuleView['metric'];
  readonly comparator?: AlertRuleView['comparator'];
  readonly threshold?: number;
  readonly silenceSeconds?: number;
}

export const useAlerts = (
  scope: 'active' | 'all' = 'active',
): UseQueryResult<readonly AlertView[]> =>
  useQuery({
    queryKey: [...keys.alerts, scope],
    queryFn: () =>
      http.get<readonly AlertView[]>(`/api/agents/alerts?scope=${scope}`),
    refetchInterval: LIVE_MS,
  });

export const useAckAlert = () => {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => http.post(`/api/agents/alerts/${id}/ack`),
    onSuccess: () => client.invalidateQueries({ queryKey: keys.alerts }),
  });
};

export const useAlertRules = (): UseQueryResult<readonly AlertRuleView[]> =>
  useQuery({
    queryKey: keys.alertRules,
    queryFn: () =>
      http.get<readonly AlertRuleView[]>('/api/agents/alert-rules'),
  });

export const useAddAlertRule = () => {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (rule: NewAlertRule) =>
      http.post<AlertRuleView>('/api/agents/alert-rules', rule),
    onSuccess: () => client.invalidateQueries({ queryKey: keys.alertRules }),
  });
};

export const useDeleteAlertRule = () => {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => http.del(`/api/agents/alert-rules/${id}`),
    onSuccess: () => client.invalidateQueries({ queryKey: keys.alertRules }),
  });
};

export const useSetAlertWebhook = () => {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (url: string) =>
      http.put<FleetSettings>('/api/agents/alert-webhook', { url }),
    onSuccess: () => client.invalidateQueries({ queryKey: keys.settings }),
  });
};
