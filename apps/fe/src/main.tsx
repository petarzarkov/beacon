import { MantineProvider } from '@mantine/core';
import { Notifications } from '@mantine/notifications';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import '@mantine/core/styles.css';
import '@mantine/notifications/styles.css';

/**
 * One client for the app. `retry: false` because a 401 is not a transient
 * failure to retry through - it means the session lapsed, and the right response
 * is to show the login page, which the session query already drives.
 */
const client = new QueryClient({
  defaultOptions: {
    queries: { retry: false, refetchOnWindowFocus: true },
  },
});

const root = document.getElementById('root');
if (!root) throw new Error('No #root to mount on');

createRoot(root).render(
  <StrictMode>
    <MantineProvider defaultColorScheme="auto">
      <Notifications />
      <QueryClientProvider client={client}>
        <App />
      </QueryClientProvider>
    </MantineProvider>
  </StrictMode>,
);
