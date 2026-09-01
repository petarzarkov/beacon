import {
  ActionIcon,
  AppShell,
  Avatar,
  Badge,
  Button,
  Group,
  Menu,
  Text,
  Tooltip,
  useMantineColorScheme,
} from '@mantine/core';
import {
  IconBinaryTree,
  IconDeviceDesktop,
  IconLogout,
  IconMenu2,
  IconMoon,
  IconRadar,
  IconStack2,
  IconSun,
} from '@tabler/icons-react';
import {
  Outlet,
  ScrollRestoration,
  useLocation,
  useNavigate,
} from 'react-router';
import { useDiscovered, useRelease } from '../api/agents';
import { useSession, useSignOut } from '../api/auth';
import { PropagationSwitch } from '../components/PropagationSwitch';

/**
 * The app shell, mirrored from `landbased-panel`: a header with the logo, the
 * primary nav, the fleet-wide controls (release + propagation), a theme toggle
 * and an account menu, over an `<Outlet/>` for the active page.
 *
 * The nav is horizontal buttons on wide screens and a burger menu on narrow
 * ones, and the active item is derived from the path - so a deep link or reload
 * lands with the right tab lit, which the old tab state could not do.
 */

const ReleaseBadge = (): React.ReactElement => {
  const release = useRelease();
  if (release.data == null) {
    return (
      <Tooltip label="Run `bun run build:agent` to publish one">
        <Badge color="gray" variant="light">
          no release
        </Badge>
      </Tooltip>
    );
  }
  return (
    <Badge color="teal" variant="light" visibleFrom="sm">
      release {release.data.version}
    </Badge>
  );
};

export const RootLayout = (): React.ReactElement => {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const { colorScheme, toggleColorScheme } = useMantineColorScheme();
  const session = useSession();
  const operator = session.data ?? null;
  const signOut = useSignOut();

  const discovered = useDiscovered();
  const discoveredCount = (discovered.data ?? []).filter(
    (host) => host.enrolledAgentId === null,
  ).length;

  const navItems = [
    {
      to: '/agents',
      label: 'Agents',
      icon: <IconDeviceDesktop size={16} />,
      active: pathname === '/' || pathname.startsWith('/agents'),
    },
    {
      to: '/commands',
      label: 'Commands',
      icon: <IconStack2 size={16} />,
      active: pathname.startsWith('/commands'),
    },
    {
      to: '/discovered',
      label: 'Discovered',
      icon: <IconRadar size={16} />,
      active: pathname.startsWith('/discovered'),
      count: discoveredCount,
    },
    {
      to: '/lineage',
      label: 'Lineage',
      icon: <IconBinaryTree size={16} />,
      active: pathname.startsWith('/lineage'),
    },
  ];

  return (
    <AppShell header={{ height: 60 }} padding="md">
      <ScrollRestoration />
      <AppShell.Header>
        <Group h="100%" px="md" justify="space-between" wrap="nowrap">
          <Group gap="sm" wrap="nowrap">
            <Menu position="bottom-start" shadow="md" width={200}>
              <Menu.Target>
                <ActionIcon
                  variant="subtle"
                  color="gray"
                  size="lg"
                  hiddenFrom="sm"
                  aria-label="Menu"
                >
                  <IconMenu2 size={20} />
                </ActionIcon>
              </Menu.Target>
              <Menu.Dropdown>
                {navItems.map((item) => (
                  <Menu.Item
                    key={item.to}
                    leftSection={item.icon}
                    onClick={() => navigate(item.to)}
                    c={item.active ? 'indigo' : undefined}
                    fw={item.active ? 600 : undefined}
                  >
                    {item.label}
                  </Menu.Item>
                ))}
              </Menu.Dropdown>
            </Menu>

            <Group
              gap={8}
              wrap="nowrap"
              style={{ cursor: 'pointer' }}
              onClick={() => navigate('/agents')}
            >
              <Text fw={700} size="lg">
                dunxon
              </Text>
              <ReleaseBadge />
            </Group>

            <Group gap={4} wrap="nowrap" visibleFrom="sm">
              {navItems.map((item) => (
                <Button
                  key={item.to}
                  variant={item.active ? 'light' : 'subtle'}
                  color={item.active ? 'indigo' : 'gray'}
                  size="sm"
                  leftSection={item.icon}
                  rightSection={
                    item.count && item.count > 0 ? (
                      <Badge size="xs" circle variant="filled">
                        {item.count}
                      </Badge>
                    ) : null
                  }
                  onClick={() => navigate(item.to)}
                >
                  {item.label}
                </Button>
              ))}
            </Group>
          </Group>

          <Group gap="xs" wrap="nowrap">
            {operator !== null && <PropagationSwitch operator={operator} />}
            <Tooltip
              label={colorScheme === 'dark' ? 'Light mode' : 'Dark mode'}
            >
              <ActionIcon
                variant="subtle"
                color="gray"
                onClick={() => toggleColorScheme()}
                aria-label="Toggle color scheme"
              >
                {colorScheme === 'dark' ? (
                  <IconSun size={18} />
                ) : (
                  <IconMoon size={18} />
                )}
              </ActionIcon>
            </Tooltip>
            <Menu position="bottom-end" shadow="md" width={220}>
              <Menu.Target>
                <Avatar size={32} radius="xl" style={{ cursor: 'pointer' }}>
                  {(operator?.name ?? operator?.email ?? '?')
                    .slice(0, 2)
                    .toUpperCase()}
                </Avatar>
              </Menu.Target>
              <Menu.Dropdown>
                <Menu.Label>
                  {operator?.email}
                  {operator?.role != null ? ` · ${operator.role}` : ''}
                </Menu.Label>
                <Menu.Item
                  color="red"
                  leftSection={<IconLogout size={16} />}
                  onClick={() => signOut.mutate()}
                >
                  Sign out
                </Menu.Item>
              </Menu.Dropdown>
            </Menu>
          </Group>
        </Group>
      </AppShell.Header>

      <AppShell.Main>
        <Outlet />
      </AppShell.Main>
    </AppShell>
  );
};
