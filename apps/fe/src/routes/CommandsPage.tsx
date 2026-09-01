import { Container, Stack, Title } from '@mantine/core';
import { CommandsPanel } from '../components/CommandsPanel';

export const CommandsPage = (): React.ReactElement => (
  <Container size="xl" px={0}>
    <Stack gap="md">
      <Title order={3}>Commands</Title>
      <CommandsPanel />
    </Stack>
  </Container>
);
