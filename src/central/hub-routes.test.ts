import { expect, test } from 'bun:test'
import type { ContextRequest } from '../context/types'
import { type CentralCore, VIEW_PATHS, hubRoutes } from './hub-routes'

const context = { deviceId: 'dev-a', deviceName: 'laptop', version: '0.6.0' }
const remote = { key: 'github.com/acme/app', kind: 'git-remote', displayName: 'app' }
const request: ContextRequest = { host: 'claude-code', cwd: '/work/app', hostSessionId: 's-1', channel: 'prompt', prompt: 'how do we pin bun' }

function fakeCore(calls: string[]): CentralCore {
  return {
    capture: () => ({ status: 200, body: { stored: 1, duplicates: 0 } }),
    context: async (req, project, budgetMs) => {
      calls.push(`context ${req.channel} ${project.key}${budgetMs === undefined ? '' : ` ${budgetMs}`}`)
      return { text: 'memo', observationIds: [3], tokens: 2 }
    },
    read: async (tool, _args, projectKey) => {
      calls.push(`read ${tool} ${projectKey}`)
      return { result: { content: [{ type: 'text', text: 'r' }], structuredContent: {} }, count: 1 }
    },
    semantic: async () => ({ status: 'unavailable', reason: 'off' }),
    mcpRead: (read) => {
      calls.push(`mcp-read ${read.tool}`)
      return 7
    },
    importChunk: (_body, context) => {
      calls.push(`import ${context.deviceId}`)
      return { status: 200, body: { sessions: 1, prompts: 0, summaries: 0, observations: 0 } }
    },
    knownProjects: (keys) => keys.filter((key) => key === 'github.com/acme/app'),
  }
}

function routes(calls: string[], views: string[] = []) {
  return hubRoutes({
    core: () => fakeCore(calls),
    view: async (path) => {
      views.push(path)
      return { status: 200, body: { path } }
    },
    version: '0.6.1',
    hubName: 'mini',
  })
}

const call = async (table: ReturnType<typeof routes>, path: string, body: unknown) => {
  const route = table[path]
  if (route === undefined) throw new Error(`no route ${path}`)
  return route.handle(body, context)
}

test('hello names the hub and its version', async () => {
  expect(await call(routes([]), '/central/hello', {})).toEqual({ status: 200, body: { hubName: 'mini', version: '0.6.1', deviceId: 'dev-a' } })
})

test('context answers for the project the device resolved, which must be the device\'s to use', async () => {
  const calls: string[] = []
  const table = routes(calls)
  expect(await call(table, '/central/context', { request, project: remote })).toEqual({ status: 200, body: { text: 'memo', observationIds: [3], tokens: 2 } })
  expect(calls).toEqual(['context prompt github.com/acme/app'])
  await call(table, '/central/context', { request, project: remote, budgetMs: 110 })
  expect(calls.at(-1)).toBe('context prompt github.com/acme/app 110')
  expect((await call(table, '/central/context', { request, project: remote, budgetMs: -5 })).status).toBe(400)
  expect((await call(table, '/central/context', { request, project: { key: 'dev-b:/x', kind: 'path', displayName: 'x' } })).status).toBe(400)
  expect((await call(table, '/central/context', { request: { ...request, cwd: 'relative' }, project: remote })).status).toBe(400)
})

test('reads run the MCP tools with the given project scope, or none', async () => {
  const calls: string[] = []
  const table = routes(calls)
  expect((await call(table, '/central/read', { tool: 'search', args: { query: 'x' }, projectKey: 'github.com/acme/app' })).status).toBe(200)
  expect((await call(table, '/central/read', { tool: 'timeline', args: {}, projectKey: null })).status).toBe(200)
  expect(calls).toEqual(['read search github.com/acme/app', 'read timeline null'])
  expect((await call(table, '/central/read', { tool: 'purge', args: {}, projectKey: null })).status).toBe(404)
  expect((await call(table, '/central/read', { tool: 'search', args: {}, projectKey: 5 })).status).toBe(400)
})

test('MCP read reports and semantic search pass through their own parsers', async () => {
  const calls: string[] = []
  const table = routes(calls)
  const read = { host: 'claude-code', tool: 'search', projectKey: 'github.com/acme/app', returnedIds: [1], rows: 1, ms: 4, status: 'ok' }
  expect(await call(table, '/central/mcp-read', read)).toEqual({ status: 201, body: { id: 7 } })
  expect((await call(table, '/central/mcp-read', { nope: 1 })).status).toBe(400)
  expect((await call(table, '/central/semantic', { query: 'bun', project: null, k: 5 })).status).toBe(200)
  expect((await call(table, '/central/semantic', { query: 5 })).status).toBe(400)
})

test('views read only the listed dashboard paths, by GET', async () => {
  const views: string[] = []
  const table = routes([], views)
  for (const path of ['/memory/observations?limit=5', '/memory/sessions', '/metrics/summary?window=7d', '/watch?since=0', '/observer/settings', '/data/size']) {
    expect((await call(table, '/central/view', { path })).status).toBe(200)
  }
  expect(views).toHaveLength(6)
  for (const path of ['/data/purge', '/backup', '/restore', '/update/install', '/memory/../data/purge', 'http://evil/memory/x', '//evil/memory/x', '/dashboard', '/central/hello', 42]) {
    expect((await call(table, '/central/view', { path })).status).toBe(404)
  }
  expect(views).toHaveLength(6)
  expect(VIEW_PATHS).not.toContain('/data/purge')
})

test('nothing that changes or removes stored memory is a route', () => {
  const paths = Object.keys(routes([]))
  expect(paths.sort()).toEqual(['/central/capture', '/central/context', '/central/hello', '/central/import', '/central/import/known', '/central/mcp-read', '/central/read', '/central/semantic', '/central/view'])
})

test('import says which projects the hub already holds, and stores a chunk', async () => {
  const calls: string[] = []
  const table = routes(calls)
  expect(await call(table, '/central/import/known', { keys: ['github.com/acme/app', 'dev-a:/x'] })).toEqual({ status: 200, body: { known: ['github.com/acme/app'] } })
  expect((await call(table, '/central/import/known', { keys: 'all' })).status).toBe(400)
  expect((await call(table, '/central/import/known', { keys: Array.from({ length: 1_001 }, (_, i) => `k${i}`) })).status).toBe(400)
  expect((await call(table, '/central/import', {})).status).toBe(200)
  expect(calls).toEqual(['import dev-a'])
})
