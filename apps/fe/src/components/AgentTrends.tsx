import {
  Box,
  Group,
  SegmentedControl,
  SimpleGrid,
  Stack,
  Text,
} from '@mantine/core';
import { useEffect, useRef, useState } from 'react';
import { useAgentMetrics } from '../api/agents';

/**
 * The trend behind the snapshot: the agent's own memory and CPU over time.
 *
 * Rendered as plain inline SVG rather than a chart library - recharts 2 (what
 * `@mantine/charts` 8 wraps) leans on `defaultProps`, which React 19 drops, so
 * its areas silently do not render. Two single-series area charts, not one
 * dual-axis chart: memory (MB) and CPU (%) are different scales, and overlaying
 * them on two y-axes is the classic way to make a chart lie. Each names its own
 * measure in its title, so neither needs a legend.
 *
 * The SVG is sized 1:1 to its measured width - no `preserveAspectRatio` stretch,
 * which would distort the axis text - so labels stay crisp as the card resizes.
 */
const RANGES = [
  { label: '15m', value: '15' },
  { label: '1h', value: '60' },
  { label: '6h', value: '360' },
] as const;

const H = 170;
const PAD = { top: 12, right: 12, bottom: 22, left: 48 };
const mib = (bytes: number): number =>
  Math.round((bytes / 1024 / 1024) * 10) / 10;

interface Point {
  readonly at: number;
  readonly v: number | null;
}

const timeLabel = (ms: number): string =>
  new Date(ms).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });

/** Measures the container so the SVG can be drawn 1:1 (no text distortion). */
const useWidth = (): [React.RefObject<HTMLDivElement | null>, number] => {
  const ref = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(600);
  useEffect(() => {
    const el = ref.current;
    if (el === null) return;
    setWidth(el.clientWidth);
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setWidth(entry.contentRect.width);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return [ref, width];
};

const TrendChart = ({
  data,
  color,
  unit,
  decimals,
}: {
  data: readonly Point[];
  color: string;
  unit: string;
  decimals: number;
}): React.ReactElement => {
  const [ref, width] = useWidth();
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);

  const plotted = data.filter(
    (p): p is { at: number; v: number } => p.v !== null,
  );
  if (plotted.length === 0) {
    return (
      <Box ref={ref}>
        <Text c="dimmed" size="sm">
          No data in this window yet.
        </Text>
      </Box>
    );
  }

  const values = plotted.map((p) => p.v);
  let min = Math.min(...values);
  let max = Math.max(...values);
  if (min === max) {
    min = Math.max(0, min - 1);
    max = max + 1;
  } else {
    const pad = (max - min) * 0.12;
    min = Math.max(0, min - pad);
    max = max + pad;
  }

  const innerW = Math.max(1, width - PAD.left - PAD.right);
  const innerH = H - PAD.top - PAD.bottom;
  const x = (i: number): number =>
    PAD.left +
    (plotted.length === 1 ? innerW / 2 : (i / (plotted.length - 1)) * innerW);
  const y = (v: number): number =>
    PAD.top + innerH - ((v - min) / (max - min)) * innerH;

  const line = plotted
    .map(
      (p, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(p.v).toFixed(1)}`,
    )
    .join(' ');
  const baseline = PAD.top + innerH;
  const area = `${line} L${x(plotted.length - 1).toFixed(1)},${baseline} L${x(0).toFixed(1)},${baseline} Z`;

  const ticks = [max, (max + min) / 2, min];
  const hovered = hoverIndex === null ? null : plotted[hoverIndex];
  const tip = (value: number): string => `${value.toFixed(decimals)}${unit}`;

  const onMove = (event: React.MouseEvent<HTMLDivElement>): void => {
    const rect = ref.current?.getBoundingClientRect();
    if (rect === undefined || rect.width === 0) return;
    const px = event.clientX - rect.left;
    const i = Math.round(((px - PAD.left) / innerW) * (plotted.length - 1));
    setHoverIndex(Math.max(0, Math.min(plotted.length - 1, i)));
  };

  return (
    <Box
      ref={ref}
      pos="relative"
      onMouseMove={onMove}
      onMouseLeave={() => setHoverIndex(null)}
    >
      <svg width={width} height={H} role="img" aria-label="trend">
        {ticks.map((tick, index) => {
          const ty = y(tick);
          return (
            <g key={index}>
              <line
                x1={PAD.left}
                x2={width - PAD.right}
                y1={ty}
                y2={ty}
                stroke="var(--mantine-color-default-border)"
                strokeWidth={1}
              />
              <text
                x={PAD.left - 6}
                y={ty + 3}
                textAnchor="end"
                fontSize={10}
                fill="var(--mantine-color-dimmed)"
              >
                {tick.toFixed(decimals)}
              </text>
            </g>
          );
        })}
        <path d={area} fill={color} fillOpacity={0.15} stroke="none" />
        <path
          d={line}
          fill="none"
          stroke={color}
          strokeWidth={2}
          strokeLinejoin="round"
        />
        {hovered !== null && (
          <>
            <line
              x1={x(hoverIndex!)}
              x2={x(hoverIndex!)}
              y1={PAD.top}
              y2={baseline}
              stroke="var(--mantine-color-dimmed)"
              strokeWidth={1}
            />
            <circle cx={x(hoverIndex!)} cy={y(hovered.v)} r={3} fill={color} />
          </>
        )}
        <text
          x={PAD.left}
          y={H - 6}
          fontSize={10}
          fill="var(--mantine-color-dimmed)"
        >
          {timeLabel(plotted[0]!.at)}
        </text>
        <text
          x={width - PAD.right}
          y={H - 6}
          textAnchor="end"
          fontSize={10}
          fill="var(--mantine-color-dimmed)"
        >
          {timeLabel(plotted[plotted.length - 1]!.at)}
        </text>
      </svg>
      {hovered !== null && (
        <Box
          pos="absolute"
          top={2}
          left={Math.min(
            Math.max(x(hoverIndex!) - 40, 0),
            Math.max(0, width - 96),
          )}
          style={{
            pointerEvents: 'none',
            background: 'var(--mantine-color-body)',
            border: '1px solid var(--mantine-color-default-border)',
            borderRadius: 4,
            padding: '2px 6px',
            whiteSpace: 'nowrap',
          }}
        >
          <Text size="xs" fw={600}>
            {tip(hovered.v)}
          </Text>
          <Text size="xs" c="dimmed">
            {timeLabel(hovered.at)}
          </Text>
        </Box>
      )}
    </Box>
  );
};

export const AgentTrends = ({
  agentId,
}: {
  agentId: string;
}): React.ReactElement => {
  const [minutes, setMinutes] = useState('60');
  const metrics = useAgentMetrics(agentId, Number(minutes));
  const points = metrics.data ?? [];

  const mem: Point[] = points.map((p) => ({
    at: Date.parse(p.at),
    v: mib(p.memBytes),
  }));
  const cpu: Point[] = points.map((p) => ({
    at: Date.parse(p.at),
    v: p.cpuPercent,
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

      {points.length === 0 ? (
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
            <TrendChart
              data={mem}
              color="var(--mantine-color-indigo-5)"
              unit=" MB"
              decimals={1}
            />
          </Stack>
          <Stack gap={4}>
            <Text size="xs" c="dimmed" tt="uppercase">
              Agent CPU (%)
            </Text>
            <TrendChart
              data={cpu}
              color="var(--mantine-color-teal-5)"
              unit="%"
              decimals={1}
            />
          </Stack>
        </SimpleGrid>
      )}
    </Stack>
  );
};
