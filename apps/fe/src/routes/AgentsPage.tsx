import { Container, Stack, Title } from '@mantine/core';
import { AgentsTable } from '../components/AgentsTable';

export const AgentsPage = (): React.ReactElement => (
  <Container size="xl" px={0}>
    <Stack gap="md">
      <Title order={3}>Agents</Title>
      <AgentsTable />
    </Stack>
  </Container>
);
