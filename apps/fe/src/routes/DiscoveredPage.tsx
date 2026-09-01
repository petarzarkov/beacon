import { Container, Stack, Title } from '@mantine/core';
import { DiscoveredHosts } from '../components/DiscoveredHosts';

export const DiscoveredPage = (): React.ReactElement => (
  <Container size="xl" px={0}>
    <Stack gap="md">
      <Title order={3}>Discovered hosts</Title>
      <DiscoveredHosts />
    </Stack>
  </Container>
);
