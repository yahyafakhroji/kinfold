import { expect, test } from 'bun:test'
import type { Parsed } from '../../../resources/context/types'
import { HUB_ONLY_ERROR, deviceRoute, isHubOnly } from '../../central/device-routes'
import type { Relay } from '../../central/relay'

function fakeRelay(calls: string[]): Relay {
  return {
    forward: async () => ({ sent: 0, failure: null }),
    context: async (request) => {
      calls.push(`context ${request.channel}`)
      return { text: 't', observationIds: [], tokens: 1 }
    },
    read: async (tool, _args, cwd) => {
      calls.push(`read ${tool} ${cwd}`)
      return { status: 200, body: { outcome: {} } }
    },
    semantic: async () => ({ status: 'unavailable', reason: 'x' }),
    mcpRead: async () => {
      calls.push('mcp-read')
      return { status: 201, body: { id: 1 } }
    },
    view: async (path) => {
      calls.push(`view ${path}`)
      return { status: 200, body: { path } }
    },
    hello: async () => ({ ok: true, status: 200, body: {} }),
    state: () => ({ reachable: true, failure: null, gap: null, lastContactAt: 1, queued: 0 }),
  }
}

const body = (value: unknown) => async (): Promise<Parsed<unknown>> => ({ ok: true, value })
const route = (calls: string[], method: string, path: string, value: unknown = {}) => deviceRoute(method, new URL(`http://127.0.0.1:4${path}`), body(value), { relay: fakeRelay(calls), hubName: 'mini' })

test('reads and read reports go to the relay; recall is left to the core', async () => {
  const calls: string[] = []
  expect(await route(calls, 'POST', '/context', { host: 'claude-code', cwd: '/w', hostSessionId: 's', channel: 'session_start' })).toBeNull()
  expect((await route(calls, 'POST', '/read/search', { args: { query: 'q' }, cwd: '/w' }))?.status).toBe(200)
  expect((await route(calls, 'POST', '/metrics/mcp-read', { host: null, tool: 'search', projectKey: 'k', returnedIds: [], rows: 0, ms: 1, status: 'ok' }))?.status).toBe(201)
  expect(calls).toEqual(['read search /w', 'mcp-read'])
  expect((await route(calls, 'POST', '/read/search', { nope: 1 }))?.status).toBe(400)
  expect((await route(calls, 'POST', '/read/purge', { args: {}, cwd: null }))).toBeNull()
})

test('the dashboard reads come from the hub', async () => {
  const calls: string[] = []
  for (const path of ['/memory/observations?limit=3', '/metrics/summary?window=7d', '/watch?since=5', '/observer/settings', '/data/size']) {
    expect((await route(calls, 'GET', path))?.status).toBe(200)
  }
  expect(calls).toEqual(['view /memory/observations?limit=3', 'view /metrics/summary?window=7d', 'view /watch?since=5', 'view /observer/settings', 'view /data/size'])
})

test('anything that changes or removes stored memory is refused on a device with "run this on the hub"', async () => {
  const calls: string[] = []
  const refused = [
    ['POST', '/data/purge'], ['PUT', '/data/retention'], ['POST', '/data/findings/3/resolve'], ['PUT', '/observer/settings'], ['POST', '/observer/retry'],
    ['POST', '/observer/test'], ['POST', '/observer/recheck'], ['PUT', '/observer/claude-token'], ['DELETE', '/observer/claude-token'], ['PUT', '/embedding/settings'], ['GET', '/backup'], ['POST', '/restore'], ['POST', '/restore/upload'],
    ['POST', '/restore/undo'], ['DELETE', '/memory/observations/4'],
  ] as const
  for (const [method, path] of refused) {
    expect(isHubOnly(method, path)).toBe(true)
    expect(await route(calls, method, path)).toEqual({ status: 409, body: { error: HUB_ONLY_ERROR, hubOnly: true, hub: 'mini' } })
  }
  expect(calls).toEqual([])
  for (const [method, path] of [['GET', '/data/size'], ['GET', '/memory/observations'], ['GET', '/update'], ['PUT', '/update/settings'], ['GET', '/embedding/settings']] as const) expect(isHubOnly(method, path)).toBe(false)
})

test('the device keeps its own update settings, dashboard pages and health', async () => {
  for (const [method, path] of [['GET', '/update'], ['PUT', '/update/settings'], ['GET', '/dashboard'], ['GET', '/health'], ['POST', '/spool/nudge'], ['GET', '/embedding/settings']] as const) {
    expect(await route([], method, path)).toBeNull()
  }
})

test('kinfold watch on a device shows the hub\'s prompts with this device\'s own update notice', async () => {
  const relay = fakeRelay([])
  relay.view = async () => ({ status: 200, body: { rows: [], update: { version: '9.9.9', message: 'the hub\'s own' } } })
  const answer = await deviceRoute('GET', new URL('http://127.0.0.1:4/watch?since=1'), body({}), { relay, hubName: 'mini', watchUpdate: () => ({ version: '0.6.1', message: 'Kinfold 0.6.1 is ready' }) })
  expect(answer).toEqual({ status: 200, body: { rows: [], update: { version: '0.6.1', message: 'Kinfold 0.6.1 is ready' } } })
})

test('the new dashboard\'s lists and reports come from the hub', async () => {
  const calls: string[] = []
  const paths = ['/memory/list/sessions?page=2', '/memory/list/memories', '/memory/list/activity', '/memory/list/projects', '/memory/list/devices', '/memory/sessions/4', '/memory/overview', '/memory/impact?window=7d']
  for (const path of paths) expect((await route(calls, 'GET', path))?.status).toBe(200)
  expect(calls).toEqual(paths.map((path) => `view ${path}`))
})
