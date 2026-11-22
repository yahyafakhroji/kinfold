import { afterEach, expect, test } from 'bun:test'
import { ApiError, CLOSED_PATH, LOGIN_PATH, api, navigation } from './api'

const realFetch = globalThis.fetch
const realAssign = navigation.assign
afterEach(() => {
  globalThis.fetch = realFetch
  navigation.assign = realAssign
})

function answer(status: number, body: unknown) {
  const sent: RequestInit[] = []
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    sent.push(init)
    return new Response(body === null ? null : JSON.stringify(body), { status })
  }) as unknown as typeof fetch
  const went: string[] = []
  navigation.assign = (path) => void went.push(path)
  return { sent, went }
}

test('every request carries our header and the cookie, never a token', async () => {
  const { sent } = answer(200, { ok: true })
  await api('PUT', '/data/display', { holdout: true })
  expect(sent[0]).toMatchObject({ method: 'PUT', credentials: 'same-origin', headers: { 'x-sam-request': '1', 'content-type': 'application/json' } })
  expect(JSON.stringify(sent[0]!.headers)).not.toMatch(/authorization/i)
})

test('a closed dashboard sends the page to the closed screen; a lapsed session to the login page', async () => {
  const closed = answer(401, { error: 'dashboard closed', closed: true })
  await expect(api('GET', '/memory/overview')).rejects.toThrow('The dashboard closed.')
  expect(closed.went).toEqual([CLOSED_PATH])
  const lapsed = answer(401, { error: 'unauthorized' })
  await expect(api('GET', '/memory/overview')).rejects.toThrow('You were signed out.')
  expect(lapsed.went).toEqual([LOGIN_PATH])
})

test('a refusal keeps the daemon\'s own words, and says when the hub must do it', async () => {
  answer(409, { error: 'run this on the hub: this device uses central memory', hubOnly: true })
  const error = await api('POST', '/data/purge', {}).catch((caught: unknown) => caught)
  expect(error).toBeInstanceOf(ApiError)
  expect((error as ApiError).hubOnly).toBe(true)
  expect((error as ApiError).message).toBe('run this on the hub: this device uses central memory')
})
