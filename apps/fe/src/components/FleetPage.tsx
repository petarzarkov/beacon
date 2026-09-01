import {
  ActionIcon,
  Badge,
  Container,
  Group,
  Menu,
  Paper,
  Tabs,
  Text,
  Title,
  Tooltip,
} from '@mantine/core';
import { IconLogout, IconUserCircle } from '@tabler/icons-react';
import { useDiscovered, useRelease } from '../api/agents';
import { useSignOut, type Operator } from '../api/auth';
import { agentIdFromPath, usePath } from '../lib/nav';
import { AgentDetail } from './AgentDetail';
import { AgentsTable } from './AgentsTable';
import { CommandsPanel } from './CommandsPanel';
import { DiscoveredHosts } from './DiscoveredHosts';
import { PropagationSwitch } from './PropagationSwitch';

const ReleaseBadge = (): React.ReactElement => {
  const release = useRelease();
  if (release.data == null) {
    return (
      <Tooltip label="Run `bun run build:agent` to publish one">
        <Badge color="gray" variant="light">
          no release
        </Badge>
      </Tooltip>
    );
  }
  return (
    <Badge color="teal" variant="light">
      release {release.data.version}
    </Badge>
  );
};

const Account = ({ operator }: { operator: Operator }): React.ReactElement => {
  const signOut = useSignOut();
  return (
    <Menu position="bottom-end" withArrow>
      <Menu.Target>
        <ActionIcon variant="subtle" size="lg" aria-label="Account">
          <IconUserCircle size={22} />
        </ActionIcon>
      </Menu.Target>
      <Menu.Dropdown>
        <Menu.Label>
          {operator.email}
          {operator.role !== null ? ` · ${operator.role}` : ''}
        </Menu.Label>
        <Menu.Item
          leftSection={<IconLogout size={16} />}
          onClick={() => signOut.mutate()}
        >
          Sign out
        </Menu.Item>
      </Menu.Dropdown>
    </Menu>
  );
};

/**
 * The console proper. One page, three views: what is reporting, what has been
 * asked of it, and what could be brought into the fleet. The discovered tab
 * hides itself until a sweep has found something, so it is not an empty promise.
 */
export const FleetPage = ({
  operator,
}: {
  operator: Operator;
}): React.ReactElement => {
  const discovered = useDiscovered();
  const discoveredCount = (discovered.data ?? []).filter(
    (host) => host.enrolledAgentId === null,
  ).length;

  // The one route besides the fleet: an agent's own page. Read from the URL, so
  // it deep-links and survives a reload (the panel serves the SPA for it).
  const selectedAgentId = agentIdFromPath(usePath());

  return (
    <Container size="xl" py="lg">
      <Group justify="space-between" mb="lg">
        <Group gap="sm">
          <Title order={2}>dunxon</Title>
          <ReleaseBadge />
        </Group>
        <Group gap="md">
          <PropagationSwitch operator={operator} />
          <Group gap="xs">
            <Text size="sm" c="dimmed">
              {operator.name}
            </Text>
            <Account operator={operator} />
          </Group>
        </Group>
      </Group>

      {selectedAgentId !== null ? (
        <AgentDetail agentId={selectedAgentId} />
      ) : (
        <Paper withBorder radius="md" p="md">
          <Tabs defaultValue="agents">
            <Tabs.List mb="md">
              <Tabs.Tab value="agents">Agents</Tabs.Tab>
              <Tabs.Tab value="commands">Commands</Tabs.Tab>
              <Tabs.Tab
                value="discovered"
                rightSection={
                  discoveredCount > 0 ? (
                    <Badge size="xs" circle variant="filled">
                      {discoveredCount}
                    </Badge>
                  ) : null
                }
              >
                Discovered
              </Tabs.Tab>
            </Tabs.List>

            <Tabs.Panel value="agents">
              <AgentsTable />
            </Tabs.Panel>
            <Tabs.Panel value="commands">
              <CommandsPanel />
            </Tabs.Panel>
            <Tabs.Panel value="discovered">
              <DiscoveredHosts />
            </Tabs.Panel>
          </Tabs>
        </Paper>
      )}
    </Container>
  );
};
