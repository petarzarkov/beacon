import { Container, MantineProvider, Title } from '@mantine/core';
import { Notifications } from '@mantine/notifications';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { AgentsTable } from './AgentsTable';
import '@mantine/core/styles.css';
import '@mantine/notifications/styles.css';

const client = new QueryClient();
const root = document.getElementById('root');
if (!root) throw new Error('No #root to mount on');

createRoot(root).render(
  <StrictMode>
    <MantineProvider defaultColorScheme="auto">
      <Notifications />
      <QueryClientProvider client={client}>
        <Container size="lg" py="xl">
          <Title order={2} mb="md">
            Agents
          </Title>
          <AgentsTable />
        </Container>
      </QueryClientProvider>
    </MantineProvider>
  </StrictMode>,
);
