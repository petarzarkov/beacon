import {
  ActionIcon,
  Button,
  Code,
  Divider,
  Group,
  ScrollArea,
  Select,
  Stack,
  Text,
  TextInput,
  Tooltip,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconPlayerPlay, IconPlus, IconTrash } from '@tabler/icons-react';
import { useState } from 'react';
import {
  useAddLibraryEntry,
  useCommandLibrary,
  useCommands,
  useDeleteLibraryEntry,
  useFleetSettings,
  useRunArbitrary,
  useRunLibrary,
} from '../api/agents';
import { useSession } from '../api/auth';
import { relativeTime } from '../lib/format';
import { CommandBadge } from './CommandBadge';

const notifyQueued = (label: string): void => {
  notifications.show({
    color: 'blue',
    title: 'Command queued',
    message: `Waiting for the agent to run ${label}. Nothing has happened yet.`,
    autoClose: 4000,
  });
};

const notifyError = (error: unknown): void => {
  notifications.show({
    color: 'red',
    title: 'Could not queue the command',
    message: error instanceof Error ? error.message : 'Unknown error',
  });
};

/**
 * Run a command on an agent. Two tiers, both queued as intents like everything
 * else, the output arriving as the command's outcome:
 *
 * - **Library** (any operator) - pick an admin-curated named command.
 * - **Free-form** (admin, when the panel enables it) - type any command.
 *
 * Admins also curate the library here. A non-admin sees only the run controls.
 */
export const AgentCommands = ({
  agentId,
}: {
  agentId: string;
}): React.ReactElement => {
  const session = useSession();
  const isAdmin = session.data?.role === 'admin';
  const settings = useFleetSettings();
  const library = useCommandLibrary();
  const runLibrary = useRunLibrary();
  const runArbitrary = useRunArbitrary();
  const addEntry = useAddLibraryEntry();
  const deleteEntry = useDeleteLibraryEntry();
  const commands = useCommands('recent');

  const entries = library.data ?? [];
  const [selected, setSelected] = useState<string | null>(null);
  const [command, setCommand] = useState('');
  const [newName, setNewName] = useState('');
  const [newCommand, setNewCommand] = useState('');

  const latest = (commands.data ?? []).find(
    (c) => c.agentId === agentId && c.command === 'exec',
  );

  const doRunLibrary = (): void => {
    if (selected === null) return;
    const entry = entries.find((e) => e.id === selected);
    runLibrary.mutate(
      { id: agentId, libraryId: selected },
      {
        onSuccess: () => notifyQueued(entry?.name ?? 'the command'),
        onError: notifyError,
      },
    );
  };

  const doRunArbitrary = (): void => {
    if (command.trim() === '') return;
    runArbitrary.mutate(
      { id: agentId, command },
      { onSuccess: () => notifyQueued(command), onError: notifyError },
    );
  };

  const doAdd = (): void => {
    if (newName.trim() === '' || newCommand.trim() === '') return;
    addEntry.mutate(
      { name: newName.trim(), argv: ['sh', '-c', newCommand] },
      {
        onSuccess: () => {
          setNewName('');
          setNewCommand('');
          notifications.show({
            color: 'teal',
            title: 'Added to the library',
            message: `"${newName.trim()}" can now be run on any agent.`,
          });
        },
        onError: notifyError,
      },
    );
  };

  return (
    <Stack gap="sm">
      <Text fw={500}>Run command</Text>

      {/* Tier 1: run a library entry (any operator). */}
      <Group gap="xs" align="flex-end">
        <Select
          size="xs"
          label="Library command"
          placeholder={entries.length === 0 ? 'No commands yet' : 'Pick one'}
          value={selected}
          onChange={setSelected}
          disabled={entries.length === 0}
          data={entries.map((e) => ({ value: e.id, label: e.name }))}
          w={240}
          searchable
        />
        <Button
          size="xs"
          variant="light"
          leftSection={<IconPlayerPlay size={16} />}
          disabled={selected === null}
          loading={runLibrary.isPending}
          onClick={doRunLibrary}
        >
          Run
        </Button>
      </Group>

      {/* Tier 2: free-form, admin + panel-enabled only. */}
      {isAdmin && settings.data?.allowArbitraryExec === true && (
        <Group gap="xs" align="flex-end">
          <TextInput
            size="xs"
            label="Free-form command (admin)"
            placeholder="e.g. systemctl status nginx"
            value={command}
            onChange={(e) => setCommand(e.currentTarget.value)}
            onKeyDown={(e) => e.key === 'Enter' && doRunArbitrary()}
            style={{ flex: 1, minWidth: 240 }}
          />
          <Button
            size="xs"
            variant="light"
            color="orange"
            leftSection={<IconPlayerPlay size={16} />}
            loading={runArbitrary.isPending}
            onClick={doRunArbitrary}
          >
            Run
          </Button>
        </Group>
      )}

      {/* Latest exec output. */}
      {latest !== undefined && (
        <Stack gap={4}>
          <Group gap="xs">
            <CommandBadge command={latest} />
            {latest.label !== null && (
              <Text size="xs" ff="monospace" c="dimmed">
                {latest.label}
              </Text>
            )}
            <Text size="xs" c="dimmed">
              {relativeTime(latest.settledAt ?? latest.queuedAt)}
            </Text>
          </Group>
          {latest.detail !== null && (
            <ScrollArea.Autosize mah={280} type="auto">
              <Code block>{latest.detail}</Code>
            </ScrollArea.Autosize>
          )}
        </Stack>
      )}

      {/* Admin: curate the library. */}
      {isAdmin && (
        <>
          <Divider label="Command library (admin)" labelPosition="left" />
          {entries.length > 0 && (
            <Stack gap={4}>
              {entries.map((entry) => (
                <Group key={entry.id} gap="xs" justify="space-between">
                  <Text size="sm">
                    <b>{entry.name}</b>{' '}
                    <Text span size="xs" ff="monospace" c="dimmed">
                      {entry.argv.join(' ')}
                    </Text>
                  </Text>
                  <Tooltip label="Remove from library">
                    <ActionIcon
                      variant="subtle"
                      color="red"
                      size="sm"
                      aria-label={`Remove ${entry.name}`}
                      onClick={() => deleteEntry.mutate(entry.id)}
                    >
                      <IconTrash size={14} />
                    </ActionIcon>
                  </Tooltip>
                </Group>
              ))}
            </Stack>
          )}
          <Group gap="xs" align="flex-end">
            <TextInput
              size="xs"
              label="Name"
              placeholder="restart-nginx"
              value={newName}
              onChange={(e) => setNewName(e.currentTarget.value)}
              w={160}
            />
            <TextInput
              size="xs"
              label="Command (runs via sh -c)"
              placeholder="systemctl restart nginx"
              value={newCommand}
              onChange={(e) => setNewCommand(e.currentTarget.value)}
              onKeyDown={(e) => e.key === 'Enter' && doAdd()}
              style={{ flex: 1, minWidth: 220 }}
            />
            <Button
              size="xs"
              variant="light"
              leftSection={<IconPlus size={16} />}
              loading={addEntry.isPending}
              onClick={doAdd}
            >
              Add
            </Button>
          </Group>
        </>
      )}
    </Stack>
  );
};
