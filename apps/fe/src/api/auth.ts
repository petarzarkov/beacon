import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseQueryResult,
} from '@tanstack/react-query';
import { http, HttpError } from './http';
import { keys } from './queryKeys';

/** The signed-in operator, as Better Auth reports them. */
export interface Operator {
  readonly id: string;
  readonly email: string;
  readonly name: string;
  readonly role: string | null;
}

interface SessionResponse {
  readonly user: Operator;
}

/**
 * Whether anyone is signed in, and who.
 *
 * `GET /api/auth/get-session` answers `null` for an anonymous request rather than
 * a 401, so this is a query that returns `null`, not one that throws - which is
 * what lets the whole app gate on `data` without a try/catch at the top.
 */
export const useSession = (): UseQueryResult<Operator | null> =>
  useQuery({
    queryKey: keys.session,
    queryFn: async (): Promise<Operator | null> => {
      const session = await http.get<SessionResponse | null>(
        '/api/auth/get-session',
      );
      return session?.user ?? null;
    },
    // The session is the root of everything else, so a stale answer here is worth
    // avoiding; refetch when the tab regains focus in case it lapsed elsewhere.
    staleTime: 30_000,
    retry: false,
  });

export const useSignIn = () => {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (credentials: { email: string; password: string }) =>
      http.post('/api/auth/sign-in/email', credentials),
    // The session drives the whole tree, so a sign-in invalidates everything
    // rather than trying to patch one cache entry.
    onSuccess: () => client.invalidateQueries(),
  });
};

export const useSignOut = () => {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => http.post('/api/auth/sign-out'),
    onSuccess: () => client.invalidateQueries(),
  });
};

/** A 401 from any call means the session lapsed; surface it as "signed out". */
export const isSessionError = (error: unknown): boolean =>
  error instanceof HttpError && error.isUnauthorized;
