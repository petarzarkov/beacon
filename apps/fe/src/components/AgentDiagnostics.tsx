import {
  Button,
  Code,
  Group,
  ScrollArea,
  Select,
  Stack,
  Text,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconStethoscope } from '@tabler/icons-react';
import { useState } from 'react';
import { DIAGNOSE_PROBES, type DiagnoseProbe } from '@beacon/contract';
import { useCommands, useDiagnose } from '../api/agents';
import { CommandBadge } from './CommandBadge';
import { relativeTime } from '../lib/format';

/** Human labels for the allowlisted probes; the command each runs is the agent's. */
const LABELS: Record<DiagnoseProbe, string> = {
  disk: 'Disk usage (df)',
  memory: 'Memory (free)',
  processes: 'Top processes',
  network: 'Network sockets',
  uptime: 'Uptime & load',
};

/**
 * Run a read-only diagnostic on the host and read its output.
 *
 * The output rides back as the command's outcome, so this is the command
 * lifecycle like everything else: queued, then delivered, then completed with
 * the text - never a result the instant the button is pressed.
 */
export const AgentDiagnostics = ({
  agentId,
}: {
  agentId: string;
}): React.ReactElement => {
  const [probe, setProbe] = useState<DiagnoseProbe>('disk');
  const diagnose = useDiagnose();
  const commands = useCommands('recent');

  const latest = (commands.data ?? []).find(
    (command) => command.agentId === agentId && command.command === 'diagnose',
  );

  const run = (): void => {
    diagnose.mutate(
      { id: agentId, probe },
      {
        onSuccess: () =>
          notifications.show({
            color: 'blue',
            title: 'Diagnostic queued',
            message: `Waiting for the agent to run ${LABELS[probe]}.`,
            autoClose: 4000,
          }),
        onError: (error) =>
          notifications.show({
            color: 'red',
            title: 'Could not queue the diagnostic',
            message: error instanceof Error ? error.message : 'Unknown error',
          }),
      },
    );
  };

  return (
    <Stack gap="xs">
      <Text fw={500}>Diagnostics</Text>
      <Group gap="xs" align="flex-end">
        <Select
          size="xs"
          label="Probe"
          value={probe}
          onChange={(value) => value && setProbe(value as DiagnoseProbe)}
          data={DIAGNOSE_PROBES.map((value) => ({
            value,
            label: LABELS[value],
          }))}
          allowDeselect={false}
          w={200}
        />
        <Button
          size="xs"
          variant="light"
          leftSection={<IconStethoscope size={16} />}
          loading={diagnose.isPending}
          onClick={run}
        >
          Run
        </Button>
      </Group>

      {latest === undefined ? (
        <Text c="dimmed" size="sm">
          Read-only checks (disk, memory, processes, sockets, uptime). Run one
          to see its output here.
        </Text>
      ) : (
        <Stack gap={4}>
          <Group gap="xs">
            <CommandBadge command={latest} />
            <Text size="xs" c="dimmed">
              {relativeTime(latest.settledAt ?? latest.queuedAt)}
            </Text>
          </Group>
          {latest.detail === null ? (
            <Text c="dimmed" size="sm">
              Waiting for the agent to run it…
            </Text>
          ) : (
            <ScrollArea.Autosize mah={280} type="auto">
              <Code block>{latest.detail}</Code>
            </ScrollArea.Autosize>
          )}
        </Stack>
      )}
    </Stack>
  );
};
