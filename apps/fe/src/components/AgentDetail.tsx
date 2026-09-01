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
  Title,
  Tooltip,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import {
  IconArrowLeft,
  IconDownload,
  IconRadar,
  IconRefresh,
  IconReload,
  IconTrash,
} from '@tabler/icons-react';
import {
  useAgent,
  useCommands,
  useDiscover,
  useForgetAgent,
  useQueueCommand,
  type QueueableCommand,
} from '../api/agents';
import { bytes, duration, memoryUsed, relativeTime } from '../lib/format';
import { agentPath, fleetPath, navigate } from '../lib/nav';
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
  <Anchor
    href={fleetPath}
    onClick={(event) => {
      event.preventDefault();
      navigate(fleetPath);
    }}
  >
    <Group gap={4}>
      <IconArrowLeft size={16} />
      <Text size="sm">Fleet</Text>
    </Group>
  </Anchor>
);

/**
 * One agent in full: everything the row summarises, plus its command history and
 * the same controls, on a page an operator can link to or reload.
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
  const used = memoryUsed(it.memTotalBytes, it.memFreeBytes);
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
                onSuccess: () => navigate(fleetPath),
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
          <Field label="Host uptime">{duration(it.uptimeSeconds)}</Field>
          <Field label="Load (1m)">
            {it.load1 === null ? '—' : it.load1.toFixed(2)}
          </Field>
          <Field label="Memory">
            {used === null
              ? '—'
              : `${Math.round(used * 100)}% of ${bytes(it.memTotalBytes)}`}
          </Field>
          <Field label="Address">{it.lastIp ?? '—'}</Field>
          <Field label="Agent version">{it.agentVersion}</Field>
          <Field label="Installed by">
            {it.installedBy === null ? (
              'seed / by hand'
            ) : (
              <Anchor
                href={agentPath(it.installedBy)}
                onClick={(event) => {
                  event.preventDefault();
                  navigate(agentPath(it.installedBy as string));
                }}
              >
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

      <Stack gap="xs">
        <Text fw={500}>Command history</Text>
        {rows.length === 0 ? (
          <Text c="dimmed" size="sm">
            Nothing has been asked of this agent yet.
          </Text>
        ) : (
          <Table.ScrollContainer minWidth={520}>
            <Table verticalSpacing="sm">
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Command</Table.Th>
                  <Table.Th>Queued</Table.Th>
                  <Table.Th>Settled</Table.Th>
                  <Table.Th>By</Table.Th>
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
                    <Table.Td>
                      <Text size="sm" c="dimmed">
                        {entry.issuedBy ?? 'system'}
                      </Text>
                    </Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </Table.ScrollContainer>
        )}
      </Stack>
    </Stack>
  );
};
