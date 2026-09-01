import { Anchor, Badge, Group, Stack, Text } from '@mantine/core';
import { Link } from 'react-router';
import { useAgents, type AgentView } from '../api/agents';

/**
 * Who installed whom - the fleet as an install tree.
 *
 * Roots are the seed agents (placed by hand, `installedBy === null`); each child
 * is a host some agent reached, whether by a panel-brokered deploy or by
 * autonomous propagation - the panel attributes both to whichever agent swept and
 * found the address. A host flagged `spreader` is one locally opted in to
 * propagate, so its subtree is where the fleet is still growing.
 */

const Node = ({
  agent,
  childrenOf,
  depth,
}: {
  agent: AgentView;
  childrenOf: (id: string) => readonly AgentView[];
  depth: number;
}): React.ReactElement => {
  const kids = childrenOf(agent.id);
  return (
    <Stack
      gap={6}
      style={
        depth === 0
          ? undefined
          : {
              marginLeft: 12,
              paddingLeft: 12,
              borderLeft: '1px solid var(--mantine-color-default-border)',
            }
      }
    >
      <Group gap="xs" wrap="nowrap">
        <Anchor component={Link} to={`/agents/${agent.id}`} fw={500}>
          {agent.hostname}
        </Anchor>
        <Badge
          size="xs"
          variant="dot"
          color={agent.connected ? 'green' : 'gray'}
        >
          {agent.connected ? 'connected' : 'silent'}
        </Badge>
        {agent.propagateEnabled && (
          <Badge size="xs" color="orange" variant="light">
            spreader
          </Badge>
        )}
      </Group>
      {kids.map((child) => (
        <Node
          key={child.id}
          agent={child}
          childrenOf={childrenOf}
          depth={depth + 1}
        />
      ))}
    </Stack>
  );
};

export const LineageTree = (): React.ReactElement => {
  const agents = useAgents();
  const rows = agents.data ?? [];

  if (agents.isError) {
    return <Text c="red">Could not reach the panel.</Text>;
  }
  if (rows.length === 0) {
    return (
      <Text c="dimmed">
        No agents yet. Seed one, and anything it deploys or propagates to
        appears here beneath it.
      </Text>
    );
  }

  const byId = new Map(rows.map((agent) => [agent.id, agent]));
  const childrenOf = (id: string): readonly AgentView[] =>
    rows
      .filter((agent) => agent.installedBy === id)
      .sort((a, b) => a.hostname.localeCompare(b.hostname));

  // A root is a seed (no installer) or an orphan whose installer is gone - either
  // way it has no parent to nest under, so it anchors its own subtree.
  const roots = rows
    .filter(
      (agent) => agent.installedBy === null || !byId.has(agent.installedBy),
    )
    .sort((a, b) => a.hostname.localeCompare(b.hostname));

  return (
    <Stack gap="lg">
      {roots.map((root) => (
        <Node key={root.id} agent={root} childrenOf={childrenOf} depth={0} />
      ))}
    </Stack>
  );
};
