import { Center, Loader } from '@mantine/core';
import { Navigate, Outlet } from 'react-router';
import { useSession } from '../../api/auth';

/**
 * The gate for the whole shell. beacon signs operators in with a Better Auth
 * session cookie, so there is no token to hold - `useSession` asks the panel who
 * is signed in and answers `null` for nobody, which is the redirect to /login.
 * A full router replaces the old hand-rolled path switch, but the decision is the
 * same one: is anyone signed in.
 */
export const RequireAuth = (): React.ReactElement => {
  const session = useSession();

  if (session.isPending) {
    return (
      <Center mih="100vh">
        <Loader />
      </Center>
    );
  }
  if (!session.data) {
    return <Navigate to="/login" replace />;
  }
  return <Outlet />;
};
