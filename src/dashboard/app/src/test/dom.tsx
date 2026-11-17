// A DOM for component and page tests, present only while one such file runs:
// happy-dom replaces fetch, Request and Response on the global object, which
// the daemon tests in the same `bun test` process rely on.

import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { afterAll, afterEach, beforeAll } from 'bun:test'

export interface Route {
  status?: number
  body: unknown
}

/** Answers by path (query string included, then without), and records every request. */
export function fakeDaemon(routes: Record<string, Route | ((init: RequestInit | undefined) => Route)>) {
  const calls: { path: string; method: string; body: unknown }[] = []
  const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, 'http://127.0.0.1:1')
    const path = `${url.pathname}${url.search}`
    calls.push({ path, method: init?.method ?? 'GET', body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined })
    const found = routes[path] ?? routes[url.pathname]
    const route = typeof found === 'function' ? found(init) : found
    if (route === undefined) return new Response(JSON.stringify({ error: `no fake for ${path}` }), { status: 404 })
    return new Response(route.status === 204 ? null : JSON.stringify(route.body), { status: route.status ?? 200, headers: { 'content-type': 'application/json' } })
  }
  return { calls, fetch }
}

export function useDom(): void {
  beforeAll(() => {
    GlobalRegistrator.register({ url: 'http://127.0.0.1:1/dashboard/' })
  })
  afterEach(async () => {
    const { cleanup } = await import('@testing-library/react/pure')
    cleanup()
  })
  afterAll(async () => {
    await GlobalRegistrator.unregister()
  })
}
