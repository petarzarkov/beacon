import { QueryClient } from '@tanstack/react-query';

/**
 * One client for the app. `retry: false` because a 401 is not a transient
 * failure to retry through - it means the session lapsed, and the right response
 * is to show the login page, which the session query already drives.
 */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: false, refetchOnWindowFocus: true },
  },
});
