import { expect, test } from 'bun:test'
import type { Measured, Overview } from '../../../../dashboard/src/lib/types'
import { fakeDaemon, useDom } from '../test/dom'

useDom()

const overview = (change: Partial<Overview> = {}): Overview => ({
  memories: 294, projects: 3, sessions: 60, week: { sessions: 20, prompts: 42, promptsWithMemory: 37 },
  saved: { measured: { tokens: 182_000, sessions: 12 }, estimate: { tokens: 3_000, sessions: 4, partial: false } }, failing: [], recordsSince: 1, ...change,
})
const result = (status: 'saving' | 'cost' | 'no-difference'): [string, Measured][] => [['claude-code', { status, perTurn: status === 'cost' ? -900 : 2_000, low: 1, high: 2, heldOut: 40, normal: 372 }]]

test('the app opens on the overview and says Kinfold is working, in sentences first', async () => {
  const { render } = await import('@testing-library/react/pure')
  const { QueryClientProvider } = await import('@tanstack/react-query')
  const { RouterProvider, createMemoryHistory } = await import('@tanstack/react-router')
  const { makeRouter, queryClient } = await import('../../../../dashboard/src/router')
  const daemon = fakeDaemon({
    '/memory/overview': { body: { value: overview(), asOf: Date.now(), refreshing: false } },
    '/memory/impact?window=7d': { body: { value: { measured: result('saving') }, asOf: Date.now(), refreshing: false } },
    '/memory/list/activity': { body: { rows: [{ id: 1, at: Date.now(), kind: 'save', host: 'opencode', projectKey: 'k', project: 'datum-ui', sessionId: 1, device: null, count: 4, detail: null }], total: 1, page: 1, pageSize: 50, sort: 'time', dir: 'desc' } },
    '/restore/status': { body: { state: 'idle', step: null, lines: [], error: null, kept: null, lastBackupAt: Date.now() } },
    '/central/status': { body: { role: 'local' } },
    '/update': { body: { notice: null, release: null, install: null } },
    '/memory/list/devices': { body: { rows: [] } },
  })
  globalThis.fetch = daemon.fetch as typeof fetch
  const screen = render(<QueryClientProvider client={queryClient}><RouterProvider router={makeRouter(createMemoryHistory({ initialEntries: ['/'] }))} /></QueryClientProvider>)
  expect(await screen.findByText('Kinfold is working.')).toBeDefined()
  expect(await screen.findByText(/It saved about 182,000 tokens, measured from 412 of your turns/)).toBeDefined()
  expect(await screen.findByText('OpenCode in datum-ui: 4 new memories saved')).toBeDefined()
  expect(screen.getByRole('navigation', { name: 'Dashboard pages' })).toBeDefined()
  // Every request is a read: opening the overview changes nothing.
  expect(daemon.calls.every((call) => call.method === 'GET')).toBe(true)
})
