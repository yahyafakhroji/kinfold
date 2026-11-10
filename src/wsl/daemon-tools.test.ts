import { afterEach, beforeEach, expect, jest, test } from 'bun:test'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startDaemon } from '../daemon/daemon'
import { createReadReporter } from '../mcp/read-reporter'
import { createMcpServer } from '../mcp/server'
import { PROJECT_A, gitForProjectA, seedMcpObservation, seedMcpSession } from '../mcp/test-support'
import type { ToolOutcome } from '../mcp/tools'
import type { McpRead } from '../store/mcp-read-store'
import { T0, openTempStore } from '../observer/test-support'
import { type DaemonFetch, WSL_READ_TIMEOUT_MS, daemonToolCaller, parseToolOutcome } from './daemon-tools'

const TOKEN = 't0k'
const CWD = '/home/me/p'
const PREFIX = 'memory is unavailable from WSL: '

let dataDir: string
beforeEach(() => {
  dataDir = realpathSync(mkdtempSync(join(tmpdir(), 'sam-wsl-tools-')))
})
afterEach(() => {
  jest.useRealTimers()
  rmSync(dataDir, { recursive: true, force: true })
})

function writeEndpoint(info: Record<string, unknown> = { pid: 1, port: 37_811 }, token = TOKEN): void {
  writeFileSync(join(dataDir, 'daemon.json'), JSON.stringify(info))
  writeFileSync(join(dataDir, 'daemon.token'), `${token}\n`)
}

interface Seen {
  url: string
  init: RequestInit
}

function fakeFetch(answer: (seen: Seen) => Promise<Response>): { fetch: DaemonFetch; seen: Seen[] } {
  const seen: Seen[] = []
  return {
    seen,
    fetch: (url, init) => {
      seen.push({ url, init })
      return answer({ url, init })
    },
  }
}

const VALID: ToolOutcome = {
  result: { content: [{ type: 'text', text: 'Found 1' }], structuredContent: { status: 'ok' } },
  count: 1,
  ids: [7],
  scope: '*',
}

function textOf(outcome: Awaited<ReturnType<ReturnType<typeof daemonToolCaller>>>): string {
  expect(outcome).not.toBeNull()
  expect(outcome!.result.isError).toBe(true)
  expect(outcome!.count).toBe(0)
  expect(outcome!.result.structuredContent.status).toBe('unavailable')
  const text = outcome!.result.content[0]!.text
  expect(outcome!.result.structuredContent.reason).toBe(text.slice(PREFIX.length))
  expect(JSON.stringify(outcome)).not.toContain(TOKEN)
  return text
}

test('the caller sends the args and cwd with the token', async () => {
  writeEndpoint()
  const fake = fakeFetch(async () => Response.json({ outcome: VALID }))
  const outcome = await daemonToolCaller({ dataDir, cwd: CWD, fetch: fake.fetch })('search', { query: 'x' })
  expect(outcome).toEqual(VALID)
  expect(fake.seen).toHaveLength(1)
  const [{ url, init }] = fake.seen as [Seen]
  expect(url).toBe('http://127.0.0.1:37811/read/search')
  expect(init.method).toBe('POST')
  expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${TOKEN}`)
  expect(JSON.parse(init.body as string)).toEqual({ args: { query: 'x' }, cwd: CWD })
})

test('every way the daemon can be missing answers with the fixed text', async () => {
  const never = fakeFetch(() => new Promise<Response>(() => {}))
  const call = (fetchFn: DaemonFetch) => daemonToolCaller({ dataDir, cwd: CWD, fetch: fetchFn })('search', { query: 'x' })

  expect(textOf(await call(never.fetch))).toBe(`${PREFIX}the Windows daemon is not running (no daemon.json in ${dataDir})`)
  expect(never.seen).toHaveLength(0)

  writeEndpoint()
  const refused = fakeFetch(() => Promise.reject(Object.assign(new Error(`connect to 127.0.0.1 with ${TOKEN}`), { code: 'ConnectionRefused' })))
  expect(textOf(await call(refused.fetch))).toBe(
    `${PREFIX}the Windows daemon did not answer on 127.0.0.1:37811 (ConnectionRefused). WSL (preview) needs mirrored networking; run kinfold status in WSL`,
  )

  jest.useFakeTimers()
  const pending = call(never.fetch)
  jest.advanceTimersByTime(WSL_READ_TIMEOUT_MS + 1)
  expect(textOf(await pending)).toBe(
    `${PREFIX}the Windows daemon did not answer on 127.0.0.1:37811 (TimeoutError). WSL (preview) needs mirrored networking; run kinfold status in WSL`,
  )
  expect(never.seen[0]!.init.signal?.aborted).toBe(true)
  jest.useRealTimers()

  const missing = fakeFetch(async () => new Response('not found', { status: 404 }))
  expect(textOf(await call(missing.fetch))).toBe(`${PREFIX}the Windows daemon has no read routes; update Kinfold on Windows`)

  const garbled = fakeFetch(async () => Response.json({ outcome: { ...VALID, count: -1, leak: TOKEN } }))
  expect(textOf(await call(garbled.fetch))).toBe(`${PREFIX}the Windows daemon sent an answer this program cannot read`)
})

test('a daemon.json that is out of range or names another host is never followed', async () => {
  const fake = fakeFetch(async () => Response.json({ outcome: VALID }))
  const call = () => daemonToolCaller({ dataDir, cwd: CWD, fetch: fake.fetch })('search', { query: 'x' })
  for (const info of [{ pid: 1, port: 80 }, { pid: 1, port: 70_000 }, { pid: 1, port: 37_811.5 }, { pid: 1, port: 37_811, host: '10.0.0.2' }]) {
    writeEndpoint(info)
    expect(textOf(await call())).toContain('cannot be used')
  }
  writeEndpoint({ pid: 1, port: 37_811 }, '  ')
  expect(textOf(await call())).toContain('cannot be used')
  expect(fake.seen).toHaveLength(0)
})

test('an unknown tool never reaches the daemon', async () => {
  writeEndpoint()
  const fake = fakeFetch(async () => Response.json({ outcome: VALID }))
  const caller = daemonToolCaller({ dataDir, cwd: CWD, fetch: fake.fetch })
  expect(await caller('ingest', {})).toBeNull()
  expect(await caller('read/../metrics', {})).toBeNull()
  expect(fake.seen).toHaveLength(0)
})

test('parseToolOutcome keeps only checked fields', () => {
  expect(parseToolOutcome(VALID)).toEqual(VALID)
  expect(parseToolOutcome({ ...VALID, extra: 'x' })).toEqual(VALID)
  const bare: ToolOutcome = { result: { content: [], structuredContent: {}, isError: false }, count: 0 }
  expect(parseToolOutcome(bare)).toEqual(bare)
  const bad = [
    null,
    { ...VALID, count: 1.5 },
    { ...VALID, ids: [1, 'two'] },
    { ...VALID, scope: 3 },
    { ...VALID, result: { ...VALID.result, isError: 'yes' } },
    { ...VALID, result: { ...VALID.result, structuredContent: [] } },
    { ...VALID, result: { ...VALID.result, content: [{ type: 'image', text: 'x' }] } },
    { ...VALID, result: { ...VALID.result, content: 'text' } },
  ]
  for (const value of bad) expect(parseToolOutcome(value)).toBeNull()
})

test('a WSL MCP server finds an observation through a real loopback daemon', async () => {
  const temp = openTempStore('sam-wsl-loopback-')
  const session = seedMcpSession(temp.store, PROJECT_A, 'claude-code', 'wsl-loop')
  const id = seedMcpObservation(temp.store, { sessionId: session, projectKey: PROJECT_A, title: 'Loopback numbat answer', at: T0 })
  const daemon = startDaemon({ dataDir: temp.dataDir, port: 0, fallbackDrainMs: 60_000, log: () => {} })
  const reports: McpRead[] = []
  const reporter = createReadReporter({
    dataDir: temp.dataDir,
    host: 'claude-code',
    schedule: (task) => task(),
    fetch: async (_url, init) => {
      reports.push(JSON.parse(init.body as string) as McpRead)
      return new Response(null, { status: 201 })
    },
  })
  const server = createMcpServer({
    dataDir: temp.dataDir, cwd: temp.dataDir, git: gitForProjectA, reporter, call: daemonToolCaller({ dataDir: temp.dataDir, cwd: temp.dataDir }),
  })
  try {
    const request = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'search', arguments: { query: 'numbat', project: '*' } } }
    const reply = JSON.parse((await server.handleLine(JSON.stringify(request)))!) as { result: { content: { text: string }[]; isError?: boolean } }
    expect(reply.result.isError).toBeUndefined()
    expect(reply.result.content[0]!.text).toContain('Loopback numbat answer')
    await reporter.settled()
    expect(reports.map((read) => read.returnedIds)).toEqual([[id]])
  } finally {
    server.close()
    await daemon.stop()
    temp.cleanup()
  }
}, 20_000)
