import { AreaChart } from '@mantine/charts';
import {
  Group,
  SegmentedControl,
  SimpleGrid,
  Stack,
  Text,
} from '@mantine/core';
import { useState } from 'react';
import { useAgentMetrics } from '../api/agents';

/**
 * The trend behind the snapshot: the agent's own memory and CPU over time.
 *
 * Two single-series charts, not one dual-axis chart - memory (MB) and CPU (%)
 * are different scales, and overlaying them on two y-axes is the classic way to
 * make a chart lie. Each names its own measure, so neither needs a legend.
 */
const RANGES = [
  { label: '15m', value: '15' },
  { label: '1h', value: '60' },
  { label: '6h', value: '360' },
] as const;

const mib = (bytes: number): number =>
  Math.round((bytes / 1024 / 1024) * 10) / 10;

const Chart = ({
  data,
  dataKey,
  color,
  unit,
}: {
  data: readonly Record<string, number | string | null>[];
  dataKey: string;
  color: string;
  unit: string;
}): React.ReactElement => (
  <AreaChart
    h={180}
    data={data as Record<string, unknown>[]}
    dataKey="t"
    series={[{ name: dataKey, color }]}
    curveType="monotone"
    withDots={false}
    strokeWidth={2}
    connectNulls
    gridAxis="xy"
    withLegend={false}
    tooltipAnimationDuration={120}
    valueFormatter={(value) => `${value}${unit}`}
    xAxisProps={{ minTickGap: 48, tickMargin: 8 }}
    yAxisProps={{ width: 44 }}
  />
);

export const AgentTrends = ({
  agentId,
}: {
  agentId: string;
}): React.ReactElement => {
  const [minutes, setMinutes] = useState('60');
  const metrics = useAgentMetrics(agentId, Number(minutes));
  const points = metrics.data ?? [];

  const data = points.map((point) => ({
    t: new Date(point.at).toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }),
    mem: mib(point.memBytes),
    cpu: point.cpuPercent,
  }));

  return (
    <Stack gap="xs">
      <Group justify="space-between">
        <Text fw={500}>Trends</Text>
        <SegmentedControl
          size="xs"
          value={minutes}
          onChange={setMinutes}
          data={[...RANGES]}
        />
      </Group>

      {data.length === 0 ? (
        <Text c="dimmed" size="sm">
          No samples in this window yet. Metrics accumulate as the agent
          reports.
        </Text>
      ) : (
        <SimpleGrid cols={{ base: 1, md: 2 }} spacing="lg">
          <Stack gap={4}>
            <Text size="xs" c="dimmed" tt="uppercase">
              Agent memory (MB)
            </Text>
            <Chart data={data} dataKey="mem" color="indigo.6" unit=" MB" />
          </Stack>
          <Stack gap={4}>
            <Text size="xs" c="dimmed" tt="uppercase">
              Agent CPU (%)
            </Text>
            <Chart data={data} dataKey="cpu" color="teal.6" unit="%" />
          </Stack>
        </SimpleGrid>
      )}
    </Stack>
  );
};
