import { ActionIcon, Badge, Group, Table, Text, Tooltip } from '@mantine/core';
import { IconRefresh, IconReload, IconDownload } from '@tabler/icons-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  type Agent,
  type AgentCommand,
  listAgents,
  listCommands,
  type PendingCommand,
  queueCommand,
} from './api';

const relative = (iso: string): string => {
  const seconds = Math.round((Date.now() - Date.parse(iso)) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  return `${Math.round(seconds / 3600)}h ago`;
};

const CONTROLS: readonly {
  command: AgentCommand;
  label: string;
  Icon: typeof IconRefresh;
}[] = [
  { command: 'report', label: 'Report now', Icon: IconRefresh },
  { command: 'update', label: 'Force update', Icon: IconDownload },
  { command: 'restart', label: 'Restart', Icon: IconReload },
];

export const AgentsTable = (): React.ReactElement => {
  const client = useQueryClient();
  const agents = useQuery({
    queryKey: ['agents'],
    queryFn: listAgents,
    // The panel pushes over the websocket eventually; until then this is what
    // keeps the table honest about who has stopped reporting.
    refetchInterval: 5000,
  });
  const pending = useQuery({
    queryKey: ['commands'],
    queryFn: listCommands,
    refetchInterval: 5000,
  });
  const command = useMutation({
    mutationFn: ({ id, command }: { id: string; command: AgentCommand }) =>
      queueCommand(id, command),
    // Invalidates the command list, not the agent list: queueing one changes
    // what is outstanding, and nothing about the agent until it checks in.
    onSuccess: () => client.invalidateQueries({ queryKey: ['commands'] }),
  });

  const outstanding = (id: string): PendingCommand | undefined =>
    (pending.data ?? []).find((c) => c.agentId === id);

  if (agents.isError) return <Text c="red">Could not reach the panel.</Text>;

  const rows = (agents.data ?? []).map((agent: Agent) => (
    <Table.Tr key={agent.id}>
      <Table.Td>{agent.hostname}</Table.Td>
      <Table.Td>
        <Badge color={agent.connected ? 'green' : 'gray'} variant="light">
          {agent.connected ? 'connected' : 'silent'}
        </Badge>
      </Table.Td>
      <Table.Td>{agent.agentVersion}</Table.Td>
      <Table.Td>{relative(agent.lastSeenAt)}</Table.Td>
      <Table.Td>
        {/* The state of the intent, never a tick for having pressed the button:
            the panel cannot reach the agent, so nothing has happened yet. */}
        {outstanding(agent.id) ? (
          <Badge variant="outline" color="yellow">
            {outstanding(agent.id)?.command} {outstanding(agent.id)?.state}
          </Badge>
        ) : (
          <Text c="dimmed" size="sm">
            -
          </Text>
        )}
      </Table.Td>
      <Table.Td>
        <Group gap="xs">
          {CONTROLS.map(({ command: name, label, Icon }) => (
            <Tooltip key={name} label={label}>
              <ActionIcon
                variant="subtle"
                aria-label={label}
                loading={command.isPending}
                onClick={() => command.mutate({ id: agent.id, command: name })}
              >
                <Icon size={16} />
              </ActionIcon>
            </Tooltip>
          ))}
        </Group>
      </Table.Td>
    </Table.Tr>
  ));

  return (
    <Table highlightOnHover>
      <Table.Thead>
        <Table.Tr>
          <Table.Th>Host</Table.Th>
          <Table.Th>State</Table.Th>
          <Table.Th>Version</Table.Th>
          <Table.Th>Last report</Table.Th>
          <Table.Th>Outstanding</Table.Th>
          <Table.Th>Controls</Table.Th>
        </Table.Tr>
      </Table.Thead>
      <Table.Tbody>{rows}</Table.Tbody>
    </Table>
  );
};
