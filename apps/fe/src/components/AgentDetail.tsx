import {
  Anchor,
  Badge,
  Button,
  Center,
  Group,
  Loader,
  Paper,
  SimpleGrid,
  Stack,
  Table,
  Text,
  Timeline,
  Title,
  Tooltip,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import {
  IconArrowLeft,
  IconDownload,
  IconPlayerPlay,
  IconPlayerStop,
  IconRadar,
  IconRefresh,
  IconReload,
  IconTrash,
} from '@tabler/icons-react';
import { Link, useNavigate } from 'react-router';
import {
  useAgent,
  useAgentEvents,
  useCommands,
  useDiscover,
  useForgetAgent,
  useQueueCommand,
  type AgentEventView,
  type QueueableCommand,
} from '../api/agents';
import { bytes, duration, relativeTime } from '../lib/format';
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

const Field = ({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}): React.ReactElement => (
  <Stack gap={2}>
    <Text size="xs" c="dimmed" tt="uppercase">
      {label}
    </Text>
    <Text size="sm">{children}</Text>
  </Stack>
);

const BackLink = (): React.ReactElement => (
  <Anchor component={Link} to="/agents">
    <Group gap={4}>
      <IconArrowLeft size={16} />
      <Text size="sm">Fleet</Text>
    </Group>
  </Anchor>
);

/**
 * The lifecycle log: startups and exits, newest first. A startup with no later
 * exit is a host that vanished (a crash or lost power) rather than one that
 * stopped cleanly - the console shows the two differently because the agent can
 * only ever report the clean one.
 */
const Activity = ({ agentId }: { agentId: string }): React.ReactElement => {
  const events = useAgentEvents(agentId);
  const rows = events.data ?? [];

  if (rows.length === 0) {
    return (
      <Text c="dimmed" size="sm">
        No startup or exit reported yet.
      </Text>
    );
  }

  const icon = (event: AgentEventView): React.ReactElement =>
    event.kind === 'startup' ? (
      <IconPlayerPlay size={12} />
    ) : (
      <IconPlayerStop size={12} />
    );

  return (
    <Timeline active={-1} bulletSize={22} lineWidth={2}>
      {rows.map((event) => (
        <Timeline.Item
          key={event.id}
          bullet={icon(event)}
          color={event.kind === 'startup' ? 'teal' : 'gray'}
          title={
            <Group gap="xs">
              <Badge
                size="sm"
                variant="light"
                color={event.kind === 'startup' ? 'teal' : 'gray'}
              >
                {event.kind}
              </Badge>
              <Text size="sm">{event.message}</Text>
            </Group>
          }
        >
          <Text size="xs" c="dimmed">
            {relativeTime(event.at)}
          </Text>
        </Timeline.Item>
      ))}
    </Timeline>
  );
};

/**
 * One agent in full: everything the row summarises, plus its lifecycle activity
 * and command history, and the same controls, on a page an operator can link to
 * or reload.
 *
 * The controls keep the console's one rule - a command is an intent, never a
 * result - so they notify "queued", not "done". `forget` is the exception that
 * changes the page: with the agent gone there is nothing to show, so it returns
 * to the fleet.
 */
export const AgentDetail = ({
  agentId,
}: {
  agentId: string;
}): React.ReactElement => {
  const navigate = useNavigate();
  const agent = useAgent(agentId);
  const history = useCommands('recent');
  const command = useQueueCommand();
  const discover = useDiscover();
  const forget = useForgetAgent();

  const queue = (name: QueueableCommand): void => {
    command.mutate(
      { id: agentId, command: name },
      {
        onSuccess: (queued) =>
          notifications.show({
            color: 'blue',
            title: `${name} queued`,
            message:
              'Waiting for the agent to collect it. Nothing has run yet.',
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

  if (agent.isPending) {
    return (
      <Center mih={200}>
        <Loader />
      </Center>
    );
  }

  if (agent.isError) {
    return (
      <Stack>
        <BackLink />
        <Text c="red">
          Could not load this agent. It may have been forgotten.
        </Text>
      </Stack>
    );
  }

  const it = agent.data;
  const rows = (history.data ?? []).filter((c) => c.agentId === agentId);

  return (
    <Stack>
      <BackLink />

      <Group justify="space-between" align="flex-start">
        <Stack gap={2}>
          <Group gap="sm">
            <Title order={3}>{it.hostname}</Title>
            <Badge color={it.connected ? 'green' : 'gray'} variant="dot">
              {it.connected ? 'connected' : 'silent'}
            </Badge>
            {it.updateAvailable && (
              <Tooltip label="A newer release is published">
                <Badge color="orange" variant="light">
                  update available
                </Badge>
              </Tooltip>
            )}
          </Group>
          <Text size="sm" c="dimmed">
            {it.os} · {it.arch} · agent {it.agentVersion}
          </Text>
        </Stack>

        <Group gap="xs">
          {CONTROLS.map(({ command: name, label, Icon }) => (
            <Button
              key={name}
              size="xs"
              variant="light"
              leftSection={<Icon size={16} />}
              loading={command.isPending}
              onClick={() => queue(name)}
            >
              {label}
            </Button>
          ))}
          <Button
            size="xs"
            variant="light"
            leftSection={<IconRadar size={16} />}
            loading={discover.isPending}
            onClick={() => discover.mutate(agentId)}
          >
            Discover
          </Button>
          <Button
            size="xs"
            variant="light"
            color="red"
            leftSection={<IconTrash size={16} />}
            loading={forget.isPending}
            onClick={() =>
              forget.mutate(agentId, {
                onSuccess: () => navigate('/agents'),
              })
            }
          >
            Forget
          </Button>
        </Group>
      </Group>

      <Paper withBorder radius="md" p="md">
        <SimpleGrid cols={{ base: 2, sm: 3, md: 4 }} spacing="lg">
          <Field label="State">{it.connected ? 'connected' : 'silent'}</Field>
          <Field label="Last report">{relativeTime(it.reportedAt)}</Field>
          <Field label="Last seen">{relativeTime(it.lastSeenAt)}</Field>
          <Field label="Enrolled">{relativeTime(it.enrolledAt)}</Field>
          <Field label="Agent uptime">{duration(it.agentUptimeSeconds)}</Field>
          <Field label="Agent memory">
            {it.agentMemBytes === null ? '—' : bytes(it.agentMemBytes)}
          </Field>
          <Field label="Agent CPU">
            {it.agentCpuPercent === null
              ? '—'
              : `${it.agentCpuPercent.toFixed(1)}%`}
          </Field>
          <Field label="Address">{it.lastIp ?? '—'}</Field>
          <Field label="Agent version">{it.agentVersion}</Field>
          <Field label="Installed by">
            {it.installedBy === null ? (
              'seed / by hand'
            ) : (
              <Anchor component={Link} to={`/agents/${it.installedBy}`}>
                {it.installedBy.slice(0, 8)}
              </Anchor>
            )}
          </Field>
          <Field label="Agent id">
            <Text ff="monospace" size="sm">
              {it.id.slice(0, 8)}
            </Text>
          </Field>
        </SimpleGrid>
      </Paper>

      <SimpleGrid cols={{ base: 1, md: 2 }} spacing="lg">
        <Stack gap="xs">
          <Text fw={500}>Activity</Text>
          <Paper withBorder radius="md" p="md">
            <Activity agentId={agentId} />
          </Paper>
        </Stack>

        <Stack gap="xs">
          <Text fw={500}>Command history</Text>
          {rows.length === 0 ? (
            <Text c="dimmed" size="sm">
              Nothing has been asked of this agent yet.
            </Text>
          ) : (
            <Table.ScrollContainer minWidth={420}>
              <Table verticalSpacing="sm">
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>Command</Table.Th>
                    <Table.Th>Queued</Table.Th>
                    <Table.Th>Settled</Table.Th>
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {rows.map((entry) => (
                    <Table.Tr key={entry.id}>
                      <Table.Td>
                        <CommandBadge command={entry} />
                      </Table.Td>
                      <Table.Td>
                        <Text size="sm" c="dimmed">
                          {relativeTime(entry.queuedAt)}
                        </Text>
                      </Table.Td>
                      <Table.Td>
                        <Text size="sm" c="dimmed">
                          {entry.settledAt === null
                            ? '—'
                            : relativeTime(entry.settledAt)}
                        </Text>
                      </Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            </Table.ScrollContainer>
          )}
        </Stack>
      </SimpleGrid>
    </Stack>
  );
};
