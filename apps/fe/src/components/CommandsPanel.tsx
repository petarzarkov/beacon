import { Group, SegmentedControl, Stack, Table, Text } from '@mantine/core';
import { useState } from 'react';
import { useCommands } from '../api/agents';
import { relativeTime } from '../lib/format';
import { CommandBadge } from './CommandBadge';

/**
 * What has been asked of the fleet, and where each request got to.
 *
 * "Open" is what is still outstanding - queued or delivered, nothing yet
 * settled; "recent" is the history including what completed, failed or expired.
 * The distinction is the whole point of the view: a command is an intent with a
 * lifecycle, not an action with a result.
 */
export const CommandsPanel = (): React.ReactElement => {
  const [state, setState] = useState<'open' | 'recent'>('open');
  const commands = useCommands(state);
  const rows = commands.data ?? [];

  return (
    <Stack>
      <Group justify="space-between">
        <Text size="sm" c="dimmed">
          {state === 'open'
            ? 'Outstanding intents. Nothing here has settled.'
            : 'The recent history, settled and unsettled.'}
        </Text>
        <SegmentedControl
          size="xs"
          value={state}
          onChange={(next) => setState(next as 'open' | 'recent')}
          data={[
            { label: 'Open', value: 'open' },
            { label: 'Recent', value: 'recent' },
          ]}
        />
      </Group>

      {rows.length === 0 ? (
        <Text c="dimmed">
          {state === 'open'
            ? 'Nothing outstanding.'
            : 'No commands have been queued yet.'}
        </Text>
      ) : (
        <Table.ScrollContainer minWidth={640}>
          <Table verticalSpacing="sm">
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Command</Table.Th>
                <Table.Th>Agent</Table.Th>
                <Table.Th>Queued</Table.Th>
                <Table.Th>Settled</Table.Th>
                <Table.Th>By</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {rows.map((command) => (
                <Table.Tr key={command.id}>
                  <Table.Td>
                    <CommandBadge command={command} />
                  </Table.Td>
                  <Table.Td>
                    <Text size="sm" ff="monospace">
                      {command.agentId.slice(0, 8)}
                    </Text>
                  </Table.Td>
                  <Table.Td>
                    <Text size="sm" c="dimmed">
                      {relativeTime(command.queuedAt)}
                    </Text>
                  </Table.Td>
                  <Table.Td>
                    <Text size="sm" c="dimmed">
                      {command.settledAt === null
                        ? '—'
                        : relativeTime(command.settledAt)}
                    </Text>
                  </Table.Td>
                  <Table.Td>
                    <Text size="sm" c="dimmed">
                      {command.issuedBy ?? 'system'}
                    </Text>
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </Table.ScrollContainer>
      )}
    </Stack>
  );
};
