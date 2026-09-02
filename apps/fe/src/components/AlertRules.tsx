import {
  ActionIcon,
  Badge,
  Button,
  Group,
  NumberInput,
  Select,
  Stack,
  Text,
  TextInput,
  Tooltip,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconPlus, IconTrash } from '@tabler/icons-react';
import { useState } from 'react';
import {
  ALERT_COMPARATORS,
  ALERT_METRICS,
  ALERT_RULE_KINDS,
  type AlertMetric,
  type AlertRuleKind,
  type AlertComparator,
} from '@beacon/contract';
import {
  useAddAlertRule,
  useAlertRules,
  useDeleteAlertRule,
  useFleetSettings,
  useSetAlertWebhook,
} from '../api/agents';

const KIND_LABEL: Record<AlertRuleKind, string> = {
  metric_threshold: 'Metric threshold',
  agent_silent: 'Agent silent',
  command_failed: 'Command failed',
};
const METRIC_LABEL: Record<AlertMetric, string> = {
  agent_cpu: 'Agent CPU %',
  agent_mem_mb: 'Agent memory (MB)',
  host_load1: 'Host load (1m)',
  host_mem_pct: 'Host memory %',
};

const ruleSummary = (rule: {
  kind: AlertRuleKind;
  metric: AlertMetric | null;
  comparator: AlertComparator | null;
  threshold: number | null;
  silenceSeconds: number | null;
}): string => {
  if (rule.kind === 'metric_threshold') {
    return `${rule.metric} ${rule.comparator === 'lt' ? '<' : '>'} ${rule.threshold}`;
  }
  if (rule.kind === 'agent_silent') return `silent > ${rule.silenceSeconds}s`;
  return 'any command fails';
};

/**
 * Admin-only: the alerting rules and the notification webhook. A rule watches a
 * threshold, a silence, or a failed command; the panel evaluates them and raises
 * (and clears) alerts on the Alerts view.
 */
export const AlertRules = (): React.ReactElement => {
  const rules = useAlertRules();
  const settings = useFleetSettings();
  const add = useAddAlertRule();
  const remove = useDeleteAlertRule();
  const setWebhook = useSetAlertWebhook();

  const [name, setName] = useState('');
  const [kind, setKind] = useState<AlertRuleKind>('metric_threshold');
  const [metric, setMetric] = useState<AlertMetric>('agent_cpu');
  const [comparator, setComparator] = useState<AlertComparator>('gt');
  const [threshold, setThreshold] = useState<number | string>(80);
  const [silence, setSilence] = useState<number | string>(120);
  const [webhook, setWebhookInput] = useState<string | null>(null);

  // Seed the webhook field from settings once it loads.
  const webhookValue = webhook ?? settings.data?.alertWebhookUrl ?? '';

  const submit = (): void => {
    if (name.trim() === '') return;
    const rule =
      kind === 'metric_threshold'
        ? {
            name: name.trim(),
            kind,
            metric,
            comparator,
            threshold: Number(threshold),
          }
        : kind === 'agent_silent'
          ? { name: name.trim(), kind, silenceSeconds: Number(silence) }
          : { name: name.trim(), kind };
    add.mutate(rule, {
      onSuccess: () => {
        setName('');
        notifications.show({
          color: 'teal',
          title: 'Rule added',
          message: `"${rule.name}" is now evaluated fleet-wide.`,
        });
      },
      onError: (error) =>
        notifications.show({
          color: 'red',
          title: 'Could not add the rule',
          message: error instanceof Error ? error.message : 'Unknown error',
        }),
    });
  };

  const saveWebhook = (): void => {
    setWebhook.mutate(webhookValue, {
      onSuccess: () =>
        notifications.show({
          color: 'teal',
          title: 'Webhook saved',
          message:
            webhookValue === ''
              ? 'Notifications disabled.'
              : 'Alerts will POST there.',
        }),
    });
  };

  return (
    <Stack gap="sm">
      <Text fw={500}>Alert rules</Text>

      {(rules.data ?? []).length > 0 && (
        <Stack gap={4}>
          {(rules.data ?? []).map((rule) => (
            <Group key={rule.id} gap="xs" justify="space-between">
              <Text size="sm">
                <b>{rule.name}</b>{' '}
                <Badge size="xs" variant="light">
                  {KIND_LABEL[rule.kind]}
                </Badge>{' '}
                <Text span size="xs" c="dimmed" ff="monospace">
                  {ruleSummary(rule)}
                </Text>
              </Text>
              <Tooltip label="Delete rule">
                <ActionIcon
                  variant="subtle"
                  color="red"
                  size="sm"
                  aria-label={`Delete ${rule.name}`}
                  onClick={() => remove.mutate(rule.id)}
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
          placeholder="cpu-hot"
          value={name}
          onChange={(e) => setName(e.currentTarget.value)}
          w={140}
        />
        <Select
          size="xs"
          label="When"
          value={kind}
          onChange={(v) => v && setKind(v as AlertRuleKind)}
          data={ALERT_RULE_KINDS.map((k) => ({
            value: k,
            label: KIND_LABEL[k],
          }))}
          allowDeselect={false}
          w={150}
        />
        {kind === 'metric_threshold' && (
          <>
            <Select
              size="xs"
              label="Metric"
              value={metric}
              onChange={(v) => v && setMetric(v as AlertMetric)}
              data={ALERT_METRICS.map((m) => ({
                value: m,
                label: METRIC_LABEL[m],
              }))}
              allowDeselect={false}
              w={150}
            />
            <Select
              size="xs"
              label=" "
              value={comparator}
              onChange={(v) => v && setComparator(v as AlertComparator)}
              data={ALERT_COMPARATORS.map((c) => ({
                value: c,
                label: c === 'lt' ? '<' : '>',
              }))}
              allowDeselect={false}
              w={70}
            />
            <NumberInput
              size="xs"
              label="Threshold"
              value={threshold}
              onChange={setThreshold}
              w={110}
            />
          </>
        )}
        {kind === 'agent_silent' && (
          <NumberInput
            size="xs"
            label="Silent for (s)"
            value={silence}
            onChange={setSilence}
            min={1}
            w={120}
          />
        )}
        <Button
          size="xs"
          variant="light"
          leftSection={<IconPlus size={16} />}
          loading={add.isPending}
          onClick={submit}
        >
          Add rule
        </Button>
      </Group>

      <Group gap="xs" align="flex-end">
        <TextInput
          size="xs"
          label="Notification webhook (POSTed on fire/resolve)"
          placeholder="https://hooks.example.com/…"
          value={webhookValue}
          onChange={(e) => setWebhookInput(e.currentTarget.value)}
          style={{ flex: 1, minWidth: 260 }}
        />
        <Button
          size="xs"
          variant="light"
          loading={setWebhook.isPending}
          onClick={saveWebhook}
        >
          Save
        </Button>
      </Group>
    </Stack>
  );
};
