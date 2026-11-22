// `kinfold watch --debug` must not cost the prompt hook anything: the trace
// is recorded inside the daemon while it answers /context, so the hook makes
// the same requests, and the same number of them, whether a debug watcher is
// connected or not. A real hook against a real daemon; fetch is only counted.

import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { hideRecallLine, seedObservation } from '../../../resources/tests/context/test-support'
import { type RunningDaemon, startDaemon } from '../../daemon/daemon'
import { openStore } from '../../../resources/store/db'
import { upsertProject, upsertSession } from '../../../resources/store/writes'
import { runHook } from '../../cli/hook'

const FIXTURES = join(import.meta.dir, '../../../../test/fixtures')

let root: string
let dataDir: string
let daemon: RunningDaemon | null
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'kinfold-hook-debug-'))
  dataDir = join(root, 'data')
  hideRecallLine(dataDir)
  daemon = null
  const store = openStore(dataDir)
  try {
    upsertProject(store.db, { key: root, kind: 'path', displayName: 'debug-repo' }, Date.now())
    const other = upsertSession(store.db, { host: 'opencode', hostSessionId: 'oc-seed', projectKey: root, cwd: root, occurredAt: Date.now() - 60_000 })
    seedObservation(store, { sessionId: other, projectKey: root, host: 'opencode', title: 'Bun test reads package.json scripts', at: Date.now() - 30_000 })
  } finally {
    store.db.close()
  }
  daemon = startDaemon({ dataDir, port: 0, fallbackDrainMs: 60_000, log: () => {} })
})
afterEach(async () => {
  if (daemon !== null) await daemon.stop()
  if (root.startsWith(tmpdir())) rmSync(root, { recursive: true, force: true })
})

const payload = (name: string, fields: Record<string, unknown> = {}): string =>
  JSON.stringify({ ...JSON.parse(readFileSync(join(FIXTURES, 'claude-code', name), 'utf8')), cwd: root, ...fields })
const token = (): string => readFileSync(join(dataDir, 'daemon.token'), 'utf8').trim()
const debug = async (after: number | null): Promise<{ cursor: number; events: Record<string, unknown>[] }> =>
  (await (await fetch(`http://127.0.0.1:${daemon!.port}/watch/debug${after === null ? '' : `?after=${after}`}`, { headers: { authorization: `Bearer ${token()}` } })).json()) as never

/** The first traced event after `cursor` that `wanted` picks; the daemon records it just after it answers. */
async function eventually(cursor: number, wanted: (event: Record<string, unknown>) => boolean): Promise<Record<string, unknown> | undefined> {
  for (let tries = 0; tries < 100; tries++) {
    const found = (await debug(cursor)).events.find(wanted)
    if (found !== undefined) return found
    await Bun.sleep(20)
  }
  return undefined
}

/** The paths of every request the hook made while it ran. */
async function hookRequests(input: string): Promise<string[]> {
  const real = globalThis.fetch
  const paths: string[] = []
  const spy = spyOn(globalThis, 'fetch').mockImplementation(((url: string | URL | Request, init?: RequestInit) => {
    paths.push(new URL(typeof url === 'string' ? url : url instanceof URL ? url.href : url.url).pathname)
    return real(url, init)
  }) as typeof fetch)
  try {
    await runHook(input, dataDir, () => {})
  } finally {
    spy.mockRestore()
  }
  return paths
}

test('the prompt hook makes the same daemon requests with --debug off and on, and /context is its only round trip for recall', async () => {
  await hookRequests(payload('session-start.json', { session_id: 'debug-off' }))
  const off = await hookRequests(payload('user-prompt-submit.json', { session_id: 'debug-off' }))
  const cursor = (await debug(null)).cursor
  await hookRequests(payload('session-start.json', { session_id: 'debug-on' }))
  const on = await hookRequests(payload('user-prompt-submit.json', { session_id: 'debug-on' }))
  expect(on).toEqual(off)
  expect(off.filter((path) => path === '/context')).toHaveLength(1)
  expect(on.some((path) => path.startsWith('/watch'))).toBe(false)
  // The watcher still saw the prompt, recorded by the daemon while it answered.
  expect(await eventually(cursor, (event) => event.kind === 'prompt' && event.hostSessionId === 'debug-on')).toBeDefined()
})

test('with a debug watcher connected, a turn end is traced with its usage, and no turn_usage row is stored', async () => {
  const transcript = join(root, 'transcript.jsonl')
  const at = (s: number): string => new Date(Date.now() - 10_000 + s * 1000).toISOString()
  writeFileSync(transcript, [
    { type: 'user', isSidechain: false, timestamp: at(0), message: { role: 'user', content: 'read package.json' } },
    { type: 'assistant', isSidechain: false, timestamp: at(3), message: { id: 'm1', role: 'assistant', content: [{ type: 'text', text: 'done' }], usage: { input_tokens: 11, output_tokens: 22, cache_read_input_tokens: 33, cache_creation_input_tokens: 0 } } },
  ].map((entry) => JSON.stringify(entry)).join('\n') + '\n')
  const cursor = (await debug(null)).cursor
  await runHook(payload('session-start.json', { session_id: 'turn-1', transcript_path: transcript }), dataDir, () => {})
  await runHook(payload('user-prompt-submit.json', { session_id: 'turn-1', transcript_path: transcript }), dataDir, () => {})
  await runHook(payload('stop.json', { session_id: 'turn-1', transcript_path: transcript }), dataDir, () => {})
  const turn = await eventually(cursor, (event) => event.kind === 'turn')
  expect(turn).toMatchObject({ kind: 'turn', hostSessionId: 'turn-1', usage: { inputTokens: 11, outputTokens: 22, cacheReadTokens: 33 } })
  const store = openStore(dataDir)
  try {
    expect(store.db.query('SELECT count(*) AS n FROM turn_usage').get()).toEqual({ n: 0 })
  } finally {
    store.db.close()
  }
})
