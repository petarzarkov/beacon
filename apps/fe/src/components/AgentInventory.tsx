import {
  Badge,
  Button,
  Group,
  Progress,
  SimpleGrid,
  Stack,
  Table,
  Text,
  Tooltip,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconRefresh } from '@tabler/icons-react';
import {
  useAgentInventory,
  useQueueCommand,
  type InventoryView,
} from '../api/agents';
import { bytes, relativeTime } from '../lib/format';

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

/** A used/total bar, coloured by how full the disk is. */
const DiskUsage = ({
  disk,
}: {
  disk: InventoryView['disks'][number];
}): React.ReactElement => {
  const pct =
    disk.totalBytes > 0
      ? Math.round((disk.usedBytes / disk.totalBytes) * 100)
      : 0;
  const color = pct >= 90 ? 'red' : pct >= 75 ? 'orange' : 'teal';
  return (
    <Stack gap={2} miw={160}>
      <Progress value={pct} color={color} size="sm" radius="sm" />
      <Text size="xs" c="dimmed">
        {bytes(disk.usedBytes)} / {bytes(disk.totalBytes)} ({pct}%)
      </Text>
    </Stack>
  );
};

/**
 * What a host *is*: its CPU, memory, disks and interfaces, as against the trends
 * above, which are what it is *doing*. Reported out of band from the report loop,
 * so the panel keeps the last snapshot; the refresh button re-queues an
 * `inventory` command and the new snapshot arrives when the agent next checks in.
 */
export const AgentInventory = ({
  agentId,
}: {
  agentId: string;
}): React.ReactElement => {
  const inventory = useAgentInventory(agentId);
  const command = useQueueCommand();

  const refresh = (): void => {
    command.mutate(
      { id: agentId, command: 'inventory' },
      {
        onSuccess: () =>
          notifications.show({
            color: 'blue',
            title: 'Inventory refresh queued',
            message: 'The new snapshot arrives when the agent next reports.',
            autoClose: 4000,
          }),
        onError: (error) =>
          notifications.show({
            color: 'red',
            title: 'Could not queue the refresh',
            message: error instanceof Error ? error.message : 'Unknown error',
          }),
      },
    );
  };

  const it = inventory.data ?? null;

  return (
    <Stack gap="xs">
      <Group justify="space-between">
        <Text fw={500}>Inventory</Text>
        <Group gap="xs">
          {it !== null && (
            <Text size="xs" c="dimmed">
              collected {relativeTime(it.collectedAt)}
            </Text>
          )}
          <Button
            size="xs"
            variant="light"
            leftSection={<IconRefresh size={16} />}
            loading={command.isPending}
            onClick={refresh}
          >
            Refresh
          </Button>
        </Group>
      </Group>

      {it === null ? (
        <Text c="dimmed" size="sm">
          {inventory.isPending
            ? 'Loading…'
            : 'No inventory reported yet. It arrives at agent startup, or refresh to ask for one.'}
        </Text>
      ) : (
        <Stack gap="md">
          <SimpleGrid cols={{ base: 2, sm: 3, md: 4 }} spacing="lg">
            <Field label="Platform">{it.platform}</Field>
            <Field label="OS release">{it.osRelease}</Field>
            <Field label="Architecture">{it.arch}</Field>
            <Field label="CPU">
              <Tooltip label={it.cpuModel} multiline maw={320} withArrow>
                <Text size="sm">
                  {it.cpuCores} × {it.cpuModel || 'unknown'}
                </Text>
              </Tooltip>
            </Field>
            <Field label="Memory">{bytes(it.memTotalBytes)}</Field>
          </SimpleGrid>

          <Stack gap={4}>
            <Text size="sm" fw={500}>
              Disks
            </Text>
            {it.disks.length === 0 ? (
              <Text c="dimmed" size="sm">
                None reported (the host may have no <code>df</code>).
              </Text>
            ) : (
              <Table.ScrollContainer minWidth={480}>
                <Table verticalSpacing="xs">
                  <Table.Thead>
                    <Table.Tr>
                      <Table.Th>Mount</Table.Th>
                      <Table.Th>Type</Table.Th>
                      <Table.Th>Usage</Table.Th>
                    </Table.Tr>
                  </Table.Thead>
                  <Table.Tbody>
                    {it.disks.map((disk) => (
                      <Table.Tr key={disk.mount}>
                        <Table.Td>
                          <Text ff="monospace" size="sm">
                            {disk.mount}
                          </Text>
                        </Table.Td>
                        <Table.Td>
                          <Text size="sm" c="dimmed">
                            {disk.fsType || '—'}
                          </Text>
                        </Table.Td>
                        <Table.Td>
                          <DiskUsage disk={disk} />
                        </Table.Td>
                      </Table.Tr>
                    ))}
                  </Table.Tbody>
                </Table>
              </Table.ScrollContainer>
            )}
          </Stack>

          <Stack gap={4}>
            <Text size="sm" fw={500}>
              Network
            </Text>
            {it.nics.length === 0 ? (
              <Text c="dimmed" size="sm">
                No external interfaces reported.
              </Text>
            ) : (
              <Table.ScrollContainer minWidth={480}>
                <Table verticalSpacing="xs">
                  <Table.Thead>
                    <Table.Tr>
                      <Table.Th>Interface</Table.Th>
                      <Table.Th>MAC</Table.Th>
                      <Table.Th>Addresses</Table.Th>
                    </Table.Tr>
                  </Table.Thead>
                  <Table.Tbody>
                    {it.nics.map((nic) => (
                      <Table.Tr key={nic.name}>
                        <Table.Td>
                          <Text ff="monospace" size="sm">
                            {nic.name}
                          </Text>
                        </Table.Td>
                        <Table.Td>
                          <Text ff="monospace" size="xs" c="dimmed">
                            {nic.mac || '—'}
                          </Text>
                        </Table.Td>
                        <Table.Td>
                          <Group gap={4}>
                            {nic.addresses.map((address) => (
                              <Badge
                                key={address}
                                size="sm"
                                variant="light"
                                tt="none"
                              >
                                {address}
                              </Badge>
                            ))}
                          </Group>
                        </Table.Td>
                      </Table.Tr>
                    ))}
                  </Table.Tbody>
                </Table>
              </Table.ScrollContainer>
            )}
          </Stack>
        </Stack>
      )}
    </Stack>
  );
};
