import {
  Badge,
  Button,
  Container,
  Group,
  Paper,
  SegmentedControl,
  Stack,
  Table,
  Text,
  Title,
} from '@mantine/core';
import { Link } from 'react-router';
import { useState } from 'react';
import type { AlertState } from '@beacon/contract';
import { useAckAlert, useAlerts } from '../api/agents';
import { useSession } from '../api/auth';
import { relativeTime } from '../lib/format';
import { AlertRules } from '../components/AlertRules';

const STATE_COLOR: Record<AlertState, string> = {
  firing: 'red',
  acknowledged: 'yellow',
  resolved: 'gray',
};

/**
 * What's wrong right now, and the rules that decide it. The list defaults to
 * open alerts (firing or acknowledged); "All" includes resolved history. Admins
 * also manage the rules and the notification webhook here.
 */
export const AlertsPage = (): React.ReactElement => {
  const [scope, setScope] = useState<'active' | 'all'>('active');
  const alerts = useAlerts(scope);
  const ack = useAckAlert();
  const isAdmin = useSession().data?.role === 'admin';

  const rows = alerts.data ?? [];

  return (
    <Container size="xl" px={0}>
      <Stack gap="md">
        <Group justify="space-between">
          <Title order={3}>Alerts</Title>
          <SegmentedControl
            size="xs"
            value={scope}
            onChange={(v) => setScope(v as 'active' | 'all')}
            data={[
              { label: 'Open', value: 'active' },
              { label: 'All', value: 'all' },
            ]}
          />
        </Group>

        <Paper withBorder radius="md" p="md">
          {rows.length === 0 ? (
            <Text c="dimmed" size="sm">
              {scope === 'active'
                ? 'Nothing firing. All quiet.'
                : 'No alerts have been raised yet.'}
            </Text>
          ) : (
            <Table.ScrollContainer minWidth={640}>
              <Table verticalSpacing="sm">
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>State</Table.Th>
                    <Table.Th>Rule</Table.Th>
                    <Table.Th>Agent</Table.Th>
                    <Table.Th>Detail</Table.Th>
                    <Table.Th>Since</Table.Th>
                    <Table.Th />
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {rows.map((alert) => (
                    <Table.Tr key={alert.id}>
                      <Table.Td>
                        <Badge color={STATE_COLOR[alert.state]} variant="light">
                          {alert.state}
                        </Badge>
                      </Table.Td>
                      <Table.Td>
                        <Text size="sm">{alert.ruleName}</Text>
                      </Table.Td>
                      <Table.Td>
                        <Link to={`/agents/${alert.agentId}`}>
                          {alert.agentHostname}
                        </Link>
                      </Table.Td>
                      <Table.Td>
                        <Text size="sm" c="dimmed">
                          {alert.message}
                        </Text>
                      </Table.Td>
                      <Table.Td>
                        <Text size="sm" c="dimmed">
                          {relativeTime(alert.firedAt)}
                        </Text>
                      </Table.Td>
                      <Table.Td>
                        {alert.state === 'firing' && (
                          <Button
                            size="compact-xs"
                            variant="subtle"
                            loading={ack.isPending}
                            onClick={() => ack.mutate(alert.id)}
                          >
                            Ack
                          </Button>
                        )}
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
            <AlertRules />
          </Paper>
        )}
      </Stack>
    </Container>
  );
};
