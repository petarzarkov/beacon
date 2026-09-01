import {
  Alert,
  Button,
  Card,
  Center,
  PasswordInput,
  Stack,
  Text,
  TextInput,
  Title,
} from '@mantine/core';
import { IconAlertTriangle } from '@tabler/icons-react';
import { useState, type FormEvent } from 'react';
import { Navigate, useNavigate } from 'react-router';
import { HttpError } from '../../api/http';
import { useSession, useSignIn } from '../../api/auth';

/**
 * The one page reachable without a session, and the reason `RequireAuth` sits
 * above the shell rather than inside it.
 *
 * There is no sign-up link, on purpose: an account on this console can restart
 * machines, so operators are created out of band with `bun run create:admin`. A
 * form that let anyone make one would be the same as leaving the fleet unlocked.
 */
export const LoginPage = (): React.ReactElement => {
  const session = useSession();
  const signIn = useSignIn();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  // Already signed in (or just did, in another tab): skip the form.
  if (session.data) {
    return <Navigate to="/agents" replace />;
  }

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    signIn.mutate(
      { email, password },
      { onSuccess: () => navigate('/agents', { replace: true }) },
    );
  };

  const message =
    signIn.error instanceof HttpError
      ? signIn.error.status === 401
        ? 'Wrong email or password.'
        : signIn.error.message
      : signIn.isError
        ? 'Could not reach the panel.'
        : null;

  return (
    <Center mih="100vh" p="md">
      <Card withBorder shadow="sm" radius="md" w={380} p="xl">
        <form onSubmit={submit}>
          <Stack>
            <div>
              <Title order={3}>dunxon</Title>
              <Text c="dimmed" size="sm">
                Sign in to the fleet console.
              </Text>
            </div>

            {message !== null && (
              <Alert
                color="red"
                variant="light"
                icon={<IconAlertTriangle size={16} />}
              >
                {message}
              </Alert>
            )}

            <TextInput
              label="Email"
              type="email"
              required
              autoFocus
              value={email}
              onChange={(event) => setEmail(event.currentTarget.value)}
            />
            <PasswordInput
              label="Password"
              required
              value={password}
              onChange={(event) => setPassword(event.currentTarget.value)}
            />
            <Button type="submit" loading={signIn.isPending} fullWidth>
              Sign in
            </Button>
          </Stack>
        </form>
      </Card>
    </Center>
  );
};
