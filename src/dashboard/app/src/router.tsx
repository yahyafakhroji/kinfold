// The pages and their URLs. Hash history keeps every page on the one
// /dashboard/ document the daemon serves, so a link to /dashboard/#/sessions?page=2
// needs no route of its own on the daemon. Each page is loaded when first
// opened, so the first paint carries only the shell and the page in view.

import { QueryClient } from '@tanstack/react-query'
import { createHashHistory, createRootRoute, createRoute, createRouter, lazyRouteComponent } from '@tanstack/react-router'
import { AppShell } from './components/app-shell'
import { NotFound } from './components/page'
import { parseListSearch } from './lib/list-search'

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      refetchOnWindowFocus: true,
      // A 4xx is an answer, not a hiccup: asking again would only repeat it.
      retry: (failures, error) => failures < 2 && !(error instanceof Error && 'status' in error && typeof error.status === 'number' && error.status >= 400 && error.status < 500),
    },
  },
})

const root = createRootRoute({ component: AppShell, notFoundComponent: NotFound })
const id = (params: Record<string, string>): { id: number } => ({ id: Number(params.id) })
const windowSearch = (raw: Record<string, unknown>): { window?: '30d' } => (raw.window === '30d' ? { window: '30d' } : {})

const routes = [
  createRoute({ getParentRoute: () => root, path: '/', component: lazyRouteComponent(() => import('./pages/overview'), 'OverviewPage') }),
  createRoute({ getParentRoute: () => root, path: '/sessions', validateSearch: parseListSearch, component: lazyRouteComponent(() => import('./pages/sessions'), 'SessionsPage') }),
  createRoute({ getParentRoute: () => root, path: '/sessions/$id', parseParams: id, component: lazyRouteComponent(() => import('./pages/sessions'), 'SessionFullPage') }),
  createRoute({ getParentRoute: () => root, path: '/memory', validateSearch: parseListSearch, component: lazyRouteComponent(() => import('./pages/memory'), 'MemoryPage') }),
  createRoute({ getParentRoute: () => root, path: '/memory/$id', parseParams: id, component: lazyRouteComponent(() => import('./pages/memory'), 'MemoryFullPage') }),
  createRoute({ getParentRoute: () => root, path: '/activity', validateSearch: parseListSearch, component: lazyRouteComponent(() => import('./pages/activity'), 'ActivityPage') }),
  createRoute({ getParentRoute: () => root, path: '/impact', validateSearch: windowSearch, component: lazyRouteComponent(() => import('./pages/impact'), 'ImpactPage') }),
  createRoute({ getParentRoute: () => root, path: '/settings', component: lazyRouteComponent(() => import('./pages/settings'), 'SettingsPage') }),
  createRoute({ getParentRoute: () => root, path: '/backup', component: lazyRouteComponent(() => import('./pages/backup'), 'BackupPage') }),
]

export function makeRouter(history = createHashHistory()) {
  return createRouter({ routeTree: root.addChildren(routes), history, defaultPreload: 'intent', scrollRestoration: true })
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof makeRouter>
  }
}
