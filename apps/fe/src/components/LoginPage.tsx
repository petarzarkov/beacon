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
import { HttpError } from '../api/http';
import { useSignIn } from '../api/auth';

/**
 * The one page reachable without a session, and the reason `SessionGuard` lets
 * the SPA through ahead of it.
 *
 * There is no sign-up link, on purpose: an account on this console can restart
 * machines, so operators are created out of band with `bun run create:admin`.
 * A form that let anyone make one would be the same as leaving the fleet
 * unlocked.
 */
export const LoginPage = (): React.ReactElement => {
  const signIn = useSignIn();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    signIn.mutate({ email, password });
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
