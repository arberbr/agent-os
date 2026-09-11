import { createRootRoute, createRoute, createRouter, createBrowserHistory } from '@tanstack/react-router';
import { AppShell } from '@/App';
import Dashboard from '@/pages/Dashboard';
import Agents from '@/pages/Agents';
import AgentEditor from '@/pages/AgentEditor';
import AgentRun from '@/pages/AgentRun';
import Integrations from '@/pages/Integrations';
import Runs from '@/pages/Runs';

const rootRoute = createRootRoute({
  component: AppShell,
});

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  component: Dashboard,
});

const agentsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/agents',
  component: Agents,
});

const agentsNewRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/agents/new',
  component: AgentEditor,
});

const agentDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/agents/$id',
  component: AgentEditor,
});

const agentRunRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/agents/$id/run',
  component: AgentRun,
});

const runsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/runs',
  // All keys optional so search stays optional for this route (TanStack
  // unions the tree's search schemas when resolving relative navigation).
  validateSearch: (search: Record<string, unknown>) =>
    ({
      status:
        search.status === 'completed' || search.status === 'failed' || search.status === 'running'
          ? search.status
          : undefined,
      run: typeof search.run === 'string' ? search.run : undefined,
    }) as { status?: 'completed' | 'failed' | 'running'; run?: string },
  component: Runs,
});

const integrationsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/integrations',
  validateSearch: (search: Record<string, unknown>) =>
    ({
      google: typeof search.google === 'string' ? search.google : undefined,
      group: typeof search.group === 'string' ? search.group : undefined,
      reason: typeof search.reason === 'string' ? search.reason : undefined,
    }) as { google?: string; group?: string; reason?: string },
  component: Integrations,
});

const routeTree = rootRoute.addChildren([
  indexRoute,
  agentsRoute,
  agentsNewRoute,
  agentDetailRoute,
  agentRunRoute,
  runsRoute,
  integrationsRoute,
]);

export const router = createRouter({
  routeTree,
  history: createBrowserHistory(),
});

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
