import {
  ActionIcon,
  Anchor,
  Badge,
  Group,
  Progress,
  Stack,
  Table,
  Text,
  Tooltip,
} from '@mantine/core';
import {
  IconDownload,
  IconRefresh,
  IconReload,
  IconRadar,
  IconTrash,
} from '@tabler/icons-react';
import { notifications } from '@mantine/notifications';
import {
  useAgents,
  useCommands,
  useDiscover,
  useForgetAgent,
  useQueueCommand,
  type AgentView,
  type CommandView,
  type QueueableCommand,
} from '../api/agents';
import { Link } from 'react-router';
import { memoryUsed, relativeTime } from '../lib/format';
import { CommandBadge } from './CommandBadge';

const CONTROLS: readonly {
  command: QueueableCommand;
  label: string;
  Icon: typeof IconRefresh;
}[] = [
  { command: 'report', label: 'Report now', Icon: IconRefresh },
  { command: 'update', label: 'Force update', Icon: IconDownload },
  { command: 'restart', label: 'Restart', Icon: IconReload },
];

const StateBadge = ({ agent }: { agent: AgentView }): React.ReactElement => (
  <Badge color={agent.connected ? 'green' : 'gray'} variant="dot">
    {agent.connected ? 'connected' : 'silent'}
  </Badge>
);

const Memory = ({ agent }: { agent: AgentView }): React.ReactElement => {
  const used = memoryUsed(agent.memTotalBytes, agent.memFreeBytes);
  if (used === null) {
    return (
      <Text c="dimmed" size="sm">
        —
      </Text>
    );
  }
  return (
    <Stack gap={2} w={90}>
      <Progress
        value={used * 100}
        color={used > 0.9 ? 'red' : used > 0.75 ? 'yellow' : 'blue'}
        size="sm"
      />
      <Text size="xs" c="dimmed">
        {Math.round(used * 100)}%
      </Text>
    </Stack>
  );
};

export const AgentsTable = (): React.ReactElement => {
  const agents = useAgents();
  const open = useCommands('open');
  const command = useQueueCommand();
  const discover = useDiscover();
  const forget = useForgetAgent();

  const outstanding = (id: string): CommandView | undefined =>
    (open.data ?? []).find((entry) => entry.agentId === id);

  const queue = (id: string, name: QueueableCommand): void => {
    command.mutate(
      { id, command: name },
      {
        onSuccess: (queued) =>
          notifications.show({
            color: 'blue',
            title: `${name} queued`,
            message: `Waiting for the agent to collect it. Nothing has run yet.`,
            // The whole point in one line: a queue is an intent, not a result.
            autoClose: 4000,
            id: queued.id,
          }),
        onError: (error) =>
          notifications.show({
            color: 'red',
            title: `Could not queue ${name}`,
            message: error instanceof Error ? error.message : 'Unknown error',
          }),
      },
    );
  };

  if (agents.isError) {
    return <Text c="red">Could not reach the panel.</Text>;
  }
  if ((agents.data ?? []).length === 0) {
    return (
      <Text c="dimmed">
        No agents have enrolled yet. Install one against this panel to see it
        here.
      </Text>
    );
  }

  const rows = (agents.data ?? []).map((agent) => {
    const pending = outstanding(agent.id);
    return (
      <Table.Tr key={agent.id}>
        <Table.Td>
          <Stack gap={0}>
            <Anchor component={Link} to={`/agents/${agent.id}`} fw={500}>
              {agent.hostname}
            </Anchor>
            <Text size="xs" c="dimmed">
              {agent.os} · {agent.arch}
            </Text>
          </Stack>
        </Table.Td>
        <Table.Td>
          <StateBadge agent={agent} />
        </Table.Td>
        <Table.Td>
          <Group gap={6}>
            <Text size="sm">{agent.agentVersion}</Text>
            {agent.updateAvailable && (
              <Tooltip label="A newer release is published">
                <Badge size="xs" color="orange" variant="light">
                  update
                </Badge>
              </Tooltip>
            )}
          </Group>
        </Table.Td>
        <Table.Td>
          <Text size="sm">{relativeTime(agent.lastSeenAt)}</Text>
        </Table.Td>
        <Table.Td>
          <Memory agent={agent} />
        </Table.Td>
        <Table.Td>
          {agent.load1 === null ? (
            <Text c="dimmed" size="sm">
              —
            </Text>
          ) : (
            <Text size="sm">{agent.load1.toFixed(2)}</Text>
          )}
        </Table.Td>
        <Table.Td>
          {/* The state of the intent, never a tick for the button press. */}
          {pending ? (
            <CommandBadge command={pending} />
          ) : (
            <Text c="dimmed" size="sm">
              idle
            </Text>
          )}
        </Table.Td>
        <Table.Td>
          <Group gap={4} justify="flex-end" wrap="nowrap">
            {CONTROLS.map(({ command: name, label, Icon }) => (
              <Tooltip key={name} label={label}>
                <ActionIcon
                  variant="subtle"
                  aria-label={label}
                  loading={command.isPending}
                  onClick={() => queue(agent.id, name)}
                >
                  <Icon size={16} />
                </ActionIcon>
              </Tooltip>
            ))}
            <Tooltip label="Sweep this agent's subnet">
              <ActionIcon
                variant="subtle"
                aria-label="Discover"
                loading={discover.isPending}
                onClick={() => discover.mutate(agent.id)}
              >
                <IconRadar size={16} />
              </ActionIcon>
            </Tooltip>
            <Tooltip label="Forget this agent">
              <ActionIcon
                variant="subtle"
                color="red"
                aria-label="Forget"
                onClick={() => forget.mutate(agent.id)}
              >
                <IconTrash size={16} />
              </ActionIcon>
            </Tooltip>
          </Group>
        </Table.Td>
      </Table.Tr>
    );
  });

  return (
    <Table.ScrollContainer minWidth={720}>
      <Table highlightOnHover verticalSpacing="sm">
        <Table.Thead>
          <Table.Tr>
            <Table.Th>Host</Table.Th>
            <Table.Th>State</Table.Th>
            <Table.Th>Version</Table.Th>
            <Table.Th>Last report</Table.Th>
            <Table.Th>Memory</Table.Th>
            <Table.Th>Load</Table.Th>
            <Table.Th>Outstanding</Table.Th>
            <Table.Th ta="right">Controls</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>{rows}</Table.Tbody>
      </Table>
    </Table.ScrollContainer>
  );
};
