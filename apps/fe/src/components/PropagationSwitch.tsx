import { Badge, Group, Switch, Tooltip } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { useFleetSettings, useSetPropagation } from '../api/agents';
import type { Operator } from '../api/auth';

/**
 * The fleet-wide propagation kill switch.
 *
 * Two keys turn on self-spread: a host opting in locally, and the panel being
 * armed here. This is the second, and it reaches the fleet on the next report -
 * so pausing it stops new installs within one interval, without touching a host.
 * Shown read-only to a non-admin, because arming a worm-shaped capability across
 * every machine is not a decision any signed-in user should make.
 */
export const PropagationSwitch = ({
  operator,
}: {
  operator: Operator;
}): React.ReactElement | null => {
  const settings = useFleetSettings();
  const setPropagation = useSetPropagation();
  const isAdmin = operator.role === 'admin';

  if (settings.data === undefined) return null;
  const armed = settings.data.propagationAllowed;

  if (!isAdmin) {
    return (
      <Tooltip label="Fleet-wide self-propagation (admins can change this)">
        <Badge color={armed ? 'orange' : 'gray'} variant="light">
          propagation {armed ? 'armed' : 'paused'}
        </Badge>
      </Tooltip>
    );
  }

  return (
    <Tooltip
      label={
        armed
          ? 'Agents that opted in are spreading. Toggle to pause the fleet.'
          : 'Paused. Opted-in agents will not spread until armed.'
      }
      multiline
      maw={260}
      withArrow
    >
      <Group gap={6}>
        <Switch
          size="sm"
          color="orange"
          checked={armed}
          disabled={setPropagation.isPending}
          onLabel="on"
          offLabel="off"
          label="Propagation"
          labelPosition="left"
          onChange={(event) => {
            const next = event.currentTarget.checked;
            setPropagation.mutate(next, {
              onSuccess: () =>
                notifications.show({
                  color: next ? 'orange' : 'gray',
                  title: next
                    ? 'Fleet propagation armed'
                    : 'Fleet propagation paused',
                  message: next
                    ? 'Opted-in agents will begin spreading on their next pass.'
                    : 'Agents stop spreading within one report interval.',
                }),
              onError: (error) =>
                notifications.show({
                  color: 'red',
                  title: 'Could not change the switch',
                  message:
                    error instanceof Error ? error.message : 'Unknown error',
                }),
            });
          }}
        />
      </Group>
    </Tooltip>
  );
};
