import {
  Alert,
  Button,
  Modal,
  NumberInput,
  SegmentedControl,
  Stack,
  Text,
  Textarea,
  TextInput,
} from '@mantine/core';
import { IconInfoCircle } from '@tabler/icons-react';
import { notifications } from '@mantine/notifications';
import { useState } from 'react';
import { useDeploy, type DiscoveryView } from '../api/agents';

/**
 * Install onto a host the panel cannot reach, by asking an agent that can.
 *
 * The credential is entered here, per deployment, and travels with the job rather
 * than being stored - so nothing in the fleet holds a standing key. The panel URL
 * defaults to this console's own origin, because the target dials the panel back
 * and the panel cannot know which of its addresses a different host can reach.
 */
export const DeployModal = ({
  host,
  onClose,
}: {
  host: DiscoveryView | null;
  onClose: () => void;
}): React.ReactElement => {
  const deploy = useDeploy();
  const [kind, setKind] = useState<'password' | 'privateKey'>('password');
  const [username, setUsername] = useState('root');
  const [value, setValue] = useState('');
  const [port, setPort] = useState<number>(22);
  const [panelUrl, setPanelUrl] = useState(window.location.origin);

  const submit = (): void => {
    if (host === null) return;
    deploy.mutate(
      {
        target: host.address,
        credential: { kind, username, value, port },
        panelUrl,
        ttlMinutes: 10,
      },
      {
        onSuccess: () => {
          notifications.show({
            color: 'blue',
            title: 'Deployment queued',
            message: `Asking a neighbour of ${host.address} to install it. Watch the command list for the outcome.`,
          });
          onClose();
        },
        onError: (error) =>
          notifications.show({
            color: 'red',
            title: 'Could not queue the deployment',
            message: error instanceof Error ? error.message : 'Unknown error',
          }),
      },
    );
  };

  return (
    <Modal
      opened={host !== null}
      onClose={onClose}
      title={host ? `Deploy to ${host.address}` : ''}
      centered
    >
      <Stack>
        <Alert color="blue" variant="light" icon={<IconInfoCircle size={16} />}>
          The credential is used once, for this install, and never stored. A
          scoped enrolment grant is minted for {host?.address} and expires in a
          few minutes.
        </Alert>

        <SegmentedControl
          value={kind}
          onChange={(next) => setKind(next as 'password' | 'privateKey')}
          data={[
            { label: 'Password', value: 'password' },
            { label: 'Private key', value: 'privateKey' },
          ]}
          fullWidth
        />

        <TextInput
          label="SSH user"
          required
          value={username}
          onChange={(event) => setUsername(event.currentTarget.value)}
        />

        {kind === 'password' ? (
          <TextInput
            label="Password"
            type="password"
            required
            value={value}
            onChange={(event) => setValue(event.currentTarget.value)}
          />
        ) : (
          <Textarea
            label="Private key (PEM)"
            required
            autosize
            minRows={3}
            maxRows={6}
            value={value}
            onChange={(event) => setValue(event.currentTarget.value)}
          />
        )}

        <NumberInput
          label="SSH port"
          value={port}
          onChange={(next) => setPort(typeof next === 'number' ? next : 22)}
          min={1}
          max={65_535}
        />

        <TextInput
          label="Panel URL the target dials back on"
          description="Where the new agent reports. Defaults to this console's origin."
          value={panelUrl}
          onChange={(event) => setPanelUrl(event.currentTarget.value)}
        />

        <Text size="xs" c="dimmed">
          Needs `sshpass` on the installing agent for a password credential; a
          key needs none.
        </Text>

        <Button
          onClick={submit}
          loading={deploy.isPending}
          disabled={value === '' || username === ''}
        >
          Queue deployment
        </Button>
      </Stack>
    </Modal>
  );
};
