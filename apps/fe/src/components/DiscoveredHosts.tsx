import { Badge, Button, Group, Table, Text } from '@mantine/core';
import { IconServer2 } from '@tabler/icons-react';
import { useState } from 'react';
import { useDiscovered, type DiscoveryView } from '../api/agents';
import { relativeTime } from '../lib/format';
import { DeployModal } from './DeployModal';

/**
 * Hosts a sweep found that are not managed yet.
 *
 * Recorded by agents, never acted on until a person decides: the panel cannot
 * tell a kiosk that belongs in the fleet from a colleague's laptop that happens
 * to answer on 22. An address already enrolled is shown as such and cannot be
 * deployed to again.
 */
export const DiscoveredHosts = (): React.ReactElement | null => {
  const discovered = useDiscovered();
  const [target, setTarget] = useState<DiscoveryView | null>(null);

  const hosts = discovered.data ?? [];
  if (hosts.length === 0) return null;

  const rows = hosts.map((host) => (
    <Table.Tr key={`${host.foundBy}:${host.address}`}>
      <Table.Td>
        <Text fw={500}>{host.address}</Text>
        {host.hostname !== null && (
          <Text size="xs" c="dimmed">
            {host.hostname}
          </Text>
        )}
      </Table.Td>
      <Table.Td>
        <Group gap={4}>
          {host.ports.map((port) => (
            <Badge key={port} size="sm" variant="light">
              {port}
            </Badge>
          ))}
        </Group>
      </Table.Td>
      <Table.Td>
        <Text size="sm" c="dimmed">
          {relativeTime(host.lastSeenAt)}
        </Text>
      </Table.Td>
      <Table.Td ta="right">
        {host.enrolledAgentId !== null ? (
          <Badge color="green" variant="light">
            managed
          </Badge>
        ) : (
          <Button
            size="xs"
            variant="light"
            leftSection={<IconServer2 size={14} />}
            onClick={() => setTarget(host)}
          >
            Deploy
          </Button>
        )}
      </Table.Td>
    </Table.Tr>
  ));

  return (
    <>
      <Table.ScrollContainer minWidth={520}>
        <Table verticalSpacing="sm">
          <Table.Thead>
            <Table.Tr>
              <Table.Th>Address</Table.Th>
              <Table.Th>Open ports</Table.Th>
              <Table.Th>Seen</Table.Th>
              <Table.Th ta="right">Action</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>{rows}</Table.Tbody>
        </Table>
      </Table.ScrollContainer>
      <DeployModal host={target} onClose={() => setTarget(null)} />
    </>
  );
};
