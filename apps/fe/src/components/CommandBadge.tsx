import { Badge, Tooltip } from '@mantine/core';
import type { CommandView } from '../api/agents';

/**
 * A command's state, coloured by what it means for the operator.
 *
 * The wording is deliberate: a queued command has not happened, and the badge
 * says so. "restart queued" is honest; a green tick for having pressed the button
 * is not, because the panel cannot reach the agent to know.
 */
const COLOR: Record<CommandView['state'], string> = {
  queued: 'yellow',
  delivered: 'blue',
  completed: 'green',
  failed: 'red',
  expired: 'gray',
};

export const CommandBadge = ({
  command,
}: {
  command: CommandView;
}): React.ReactElement => {
  const label = `${command.command} ${command.state}`;
  const badge = (
    <Badge color={COLOR[command.state]} variant="light" tt="none">
      {label}
    </Badge>
  );
  // The detail is where a failure explains itself, or a restart records the
  // uptime that completed it. Only worth a tooltip when there is one.
  return command.detail ? (
    <Tooltip label={command.detail} multiline maw={320} withArrow>
      {badge}
    </Tooltip>
  ) : (
    badge
  );
};
