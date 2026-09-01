import { Center, Loader } from '@mantine/core';
import { useSession } from './api/auth';
import { FleetPage } from './components/FleetPage';
import { LoginPage } from './components/LoginPage';

/**
 * The whole of routing, and it is one decision: is anyone signed in.
 *
 * A full router would be three files to choose between two screens the session
 * query already distinguishes. `useSession` returns `null` for an anonymous
 * request rather than throwing, so this reads as data, not error handling - and
 * because the panel serves `index.html` for every non-API path, a deep link
 * lands here and resolves to the right screen once the session is known.
 */
export const App = (): React.ReactElement => {
  const session = useSession();

  if (session.isPending) {
    return (
      <Center mih="100vh">
        <Loader />
      </Center>
    );
  }

  const operator = session.data ?? null;
  return operator === null ? <LoginPage /> : <FleetPage operator={operator} />;
};
