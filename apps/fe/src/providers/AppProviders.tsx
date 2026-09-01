import { MantineProvider, localStorageColorSchemeManager } from '@mantine/core';
import { Notifications } from '@mantine/notifications';
import { QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import '@mantine/core/styles.css';
import '@mantine/charts/styles.css';
import '@mantine/notifications/styles.css';
import { queryClient } from '../api/queryClient';
import { theme } from '../theme';

/**
 * Everything the tree needs, in one place: Mantine (dark by default, remembered
 * per browser), notifications, and React Query. `RouterProvider` is mounted
 * inside this in `main.tsx`, so a route can use a query and a toast freely.
 */
const colorSchemeManager = localStorageColorSchemeManager({ key: 'dunxon-ui' });

export const AppProviders = ({
  children,
}: {
  children: ReactNode;
}): React.ReactElement => (
  <MantineProvider
    theme={theme}
    defaultColorScheme="dark"
    colorSchemeManager={colorSchemeManager}
  >
    <Notifications position="top-right" />
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  </MantineProvider>
);
