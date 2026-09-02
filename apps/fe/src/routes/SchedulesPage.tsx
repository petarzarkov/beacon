import {
  ActionIcon,
  Badge,
  Button,
  Container,
  Group,
  Paper,
  Select,
  Stack,
  Switch,
  Table,
  Text,
  TextInput,
  Title,
  Tooltip,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconPlayerPlay, IconPlus, IconTrash } from '@tabler/icons-react';
import { useState } from 'react';
import { Link } from 'react-router';
import {
  DIAGNOSE_PROBES,
  SCHEDULE_ACTIONS,
  type DiagnoseProbe,
  type ScheduleAction,
  type ScheduledTaskView,
} from '@beacon/contract';
import {
  useAddSchedule,
  useAgents,
  useCommandLibrary,
  useDeleteSchedule,
  useRunSchedule,
  useSchedules,
  useToggleSchedule,
} from '../api/agents';
import { useSession } from '../api/auth';
import { relativeTime } from '../lib/format';

const ACTION_LABEL: Record<ScheduleAction, string> = {
  report: 'Report',
  inventory: 'Inventory',
  diagnose: 'Diagnostic',
  exec: 'Library command',
};

/** A few common cadences, plus a free-form escape hatch. */
const CRON_PRESETS = [
  { value: '@hourly', label: 'Every hour' },
  { value: '0 */6 * * *', label: 'Every 6 hours' },
  { value: '@daily', label: 'Every day (midnight)' },
  { value: '@weekly', label: 'Every week' },
  { value: 'custom', label: 'Custom…' },
] as const;

/** One line describing what a task does, for the table. */
const describe = (task: ScheduledTaskView): string => {
  if (task.action === 'diagnose') return `Diagnostic · ${task.probe ?? '?'}`;
  if (task.action === 'exec') {
    return `Command · ${task.libraryName ?? task.libraryId ?? '?'}`;
  }
  return ACTION_LABEL[task.action];
};

/**
 * Recurring tasks: the panel queuing a command on a cadence. The cadence and the
 * firing are the framework's scheduler; this shows each task's next fire and run
 * count live, and lets an admin add, pause, run-now and delete them. Any operator
 * can watch; only an admin curates.
 */
export const SchedulesPage = (): React.ReactElement => {
  const tasks = useSchedules();
  const runNow = useRunSchedule();
  const toggle = useToggleSchedule();
  const remove = useDeleteSchedule();
  const isAdmin = useSession().data?.role === 'admin';

  const rows = tasks.data ?? [];

  return (
    <Container size="xl" px={0}>
      <Stack gap="md">
        <Title order={3}>Scheduled tasks</Title>

        <Paper withBorder radius="md" p="md">
          {rows.length === 0 ? (
            <Text c="dimmed" size="sm">
              No scheduled tasks yet.
              {isAdmin ? ' Add one below.' : ''}
            </Text>
          ) : (
            <Table.ScrollContainer minWidth={760}>
              <Table verticalSpacing="sm">
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>Task</Table.Th>
                    <Table.Th>Target</Table.Th>
                    <Table.Th>Does</Table.Th>
                    <Table.Th>Cadence</Table.Th>
                    <Table.Th>Next run</Table.Th>
                    <Table.Th>Runs</Table.Th>
                    <Table.Th />
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {rows.map((task) => (
                    <Table.Tr key={task.id}>
                      <Table.Td>
                        <Text size="sm" fw={500}>
                          {task.name}
                        </Text>
                        {task.lastError !== null && (
                          <Tooltip label={task.lastError} multiline maw={320}>
                            <Badge color="red" size="xs" variant="light">
                              last run failed
                            </Badge>
                          </Tooltip>
                        )}
                      </Table.Td>
                      <Table.Td>
                        {task.agentId === null ? (
                          <Badge variant="light" size="sm" tt="none">
                            whole fleet
                          </Badge>
                        ) : (
                          <Link to={`/agents/${task.agentId}`}>
                            {task.agentHostname ?? task.agentId.slice(0, 8)}
                          </Link>
                        )}
                      </Table.Td>
                      <Table.Td>
                        <Text size="sm">{describe(task)}</Text>
                      </Table.Td>
                      <Table.Td>
                        <Text size="sm" ff="monospace" c="dimmed">
                          {task.cron}
                        </Text>
                      </Table.Td>
                      <Table.Td>
                        <Text size="sm" c="dimmed">
                          {task.enabled ? relativeTime(task.nextRunAt) : '—'}
                        </Text>
                      </Table.Td>
                      <Table.Td>
                        <Text size="sm" c="dimmed">
                          {task.runs}
                        </Text>
                      </Table.Td>
                      <Table.Td>
                        <Group gap={4} justify="flex-end" wrap="nowrap">
                          {isAdmin && (
                            <>
                              <Tooltip label="Run now">
                                <ActionIcon
                                  variant="subtle"
                                  size="sm"
                                  disabled={!task.enabled}
                                  aria-label={`Run ${task.name} now`}
                                  onClick={() => runNow.mutate(task.id)}
                                >
                                  <IconPlayerPlay size={14} />
                                </ActionIcon>
                              </Tooltip>
                              <Switch
                                size="xs"
                                checked={task.enabled}
                                aria-label={`Enable ${task.name}`}
                                onChange={(e) =>
                                  toggle.mutate({
                                    id: task.id,
                                    enabled: e.currentTarget.checked,
                                  })
                                }
                              />
                              <Tooltip label="Delete task">
                                <ActionIcon
                                  variant="subtle"
                                  color="red"
                                  size="sm"
                                  aria-label={`Delete ${task.name}`}
                                  onClick={() => remove.mutate(task.id)}
                                >
                                  <IconTrash size={14} />
                                </ActionIcon>
                              </Tooltip>
                            </>
                          )}
                        </Group>
                      </Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            </Table.ScrollContainer>
          )}
        </Paper>

        {isAdmin && (
          <Paper withBorder radius="md" p="md">
            <ScheduleForm />
          </Paper>
        )}
      </Stack>
    </Container>
  );
};

/** Admin-only: define a new task - what runs, where, and how often. */
const ScheduleForm = (): React.ReactElement => {
  const add = useAddSchedule();
  const agents = useAgents();
  const library = useCommandLibrary();

  const [name, setName] = useState('');
  const [target, setTarget] = useState<string>(''); // '' = whole fleet
  const [action, setAction] = useState<ScheduleAction>('report');
  const [probe, setProbe] = useState<DiagnoseProbe>('disk');
  const [libraryId, setLibraryId] = useState<string | null>(null);
  const [preset, setPreset] = useState<string>('@daily');
  const [customCron, setCustomCron] = useState('');

  const cron = preset === 'custom' ? customCron.trim() : preset;

  const submit = (): void => {
    if (name.trim() === '' || cron === '') return;
    if (action === 'exec' && libraryId === null) return;
    const task = {
      name: name.trim(),
      ...(target === '' ? {} : { agentId: target }),
      action,
      ...(action === 'diagnose' ? { probe } : {}),
      ...(action === 'exec' && libraryId !== null ? { libraryId } : {}),
      cron,
    };
    add.mutate(task, {
      onSuccess: () => {
        setName('');
        notifications.show({
          color: 'teal',
          title: 'Task scheduled',
          message: `"${task.name}" will run ${cron}.`,
        });
      },
      onError: (error) =>
        notifications.show({
          color: 'red',
          title: 'Could not schedule the task',
          message: error instanceof Error ? error.message : 'Unknown error',
        }),
    });
  };

  const agentOptions = [
    { value: '', label: 'Whole fleet' },
    ...(agents.data ?? []).map((a) => ({ value: a.id, label: a.hostname })),
  ];

  return (
    <Stack gap="sm">
      <Text fw={500}>New scheduled task</Text>
      <Group gap="xs" align="flex-end">
        <TextInput
          size="xs"
          label="Name"
          placeholder="nightly-inventory"
          value={name}
          onChange={(e) => setName(e.currentTarget.value)}
          w={170}
        />
        <Select
          size="xs"
          label="Target"
          value={target}
          onChange={(v) => setTarget(v ?? '')}
          data={agentOptions}
          allowDeselect={false}
          searchable
          w={180}
        />
        <Select
          size="xs"
          label="Action"
          value={action}
          onChange={(v) => v && setAction(v as ScheduleAction)}
          data={SCHEDULE_ACTIONS.map((a) => ({
            value: a,
            label: ACTION_LABEL[a],
          }))}
          allowDeselect={false}
          w={150}
        />
        {action === 'diagnose' && (
          <Select
            size="xs"
            label="Probe"
            value={probe}
            onChange={(v) => v && setProbe(v as DiagnoseProbe)}
            data={DIAGNOSE_PROBES.map((p) => ({ value: p, label: p }))}
            allowDeselect={false}
            w={130}
          />
        )}
        {action === 'exec' && (
          <Select
            size="xs"
            label="Library command"
            placeholder="pick one"
            value={libraryId}
            onChange={setLibraryId}
            data={(library.data ?? []).map((entry) => ({
              value: entry.id,
              label: entry.name,
            }))}
            w={170}
          />
        )}
        <Select
          size="xs"
          label="Cadence"
          value={preset}
          onChange={(v) => v && setPreset(v)}
          data={CRON_PRESETS.map((p) => ({ value: p.value, label: p.label }))}
          allowDeselect={false}
          w={150}
        />
        {preset === 'custom' && (
          <TextInput
            size="xs"
            label="Cron"
            placeholder="0 */6 * * *"
            value={customCron}
            onChange={(e) => setCustomCron(e.currentTarget.value)}
            w={140}
          />
        )}
        <Button
          size="xs"
          variant="light"
          leftSection={<IconPlus size={16} />}
          loading={add.isPending}
          onClick={submit}
        >
          Schedule
        </Button>
      </Group>
      <Text size="xs" c="dimmed">
        Minute resolution (Bun.cron). A run rides the normal command lifecycle,
        so it shows in the command history and a failure raises a command-failed
        alert.
      </Text>
    </Stack>
  );
};
