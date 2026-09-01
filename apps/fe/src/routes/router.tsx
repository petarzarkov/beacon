import { createBrowserRouter, Navigate } from 'react-router';
import { AgentDetailPage } from './AgentDetailPage';
import { AgentsPage } from './AgentsPage';
import { CommandsPage } from './CommandsPage';
import { DiscoveredPage } from './DiscoveredPage';
import { NotFoundPage } from './NotFoundPage';
import { RootLayout } from './RootLayout';
import { LoginPage } from './auth/LoginPage';
import { RequireAuth } from './guards/RequireAuth';

/**
 * The whole route table, mirrored from `landbased-panel`: /login is public;
 * everything else sits behind `RequireAuth` and inside the `RootLayout` shell.
 *
 * `createBrowserRouter` uses real paths, which the panel already serves - the SPA
 * fallback hands back index.html for any non-API GET, so `/agents/:id` deep-links
 * and reloads land here and resolve client-side.
 */
export const router = createBrowserRouter([
  { path: '/login', Component: LoginPage },
  {
    Component: RequireAuth,
    children: [
      {
        Component: RootLayout,
        children: [
          { index: true, element: <Navigate to="/agents" replace /> },
          { path: 'agents', Component: AgentsPage },
          { path: 'agents/:agentId', Component: AgentDetailPage },
          { path: 'commands', Component: CommandsPage },
          { path: 'discovered', Component: DiscoveredPage },
          { path: '*', Component: NotFoundPage },
        ],
      },
    ],
  },
]);
