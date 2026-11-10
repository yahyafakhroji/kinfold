import { afterEach, beforeEach, expect, jest, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startDaemon } from '../daemon/daemon'
import { createReadReporter } from '../mcp/read-reporter'
import { createMcpServer } from '../mcp/server'
import { PROJECT_A, gitForProjectA, seedMcpObservation, seedMcpSession } from '../mcp/test-support'
import type { ToolOutcome } from '../mcp/tools'
import { T0, openTempStore } from '../observer/test-support'
import type { McpRead } from '../store/mcp-read-store'
import {
  type DaemonFetch, MAX_ANSWER_BYTES, WSL_FILE_TIMEOUT_MS, WSL_READ_TIMEOUT_MS, daemonToolCaller, parseToolOutcome,
} from './daemon-tools'
import type { WslProbes } from './wsl-probes'

const TOKEN = 't0k'
const CWD = '/home/me/p'
const PID = 4_242
const PORT = 37_811
const PREFIX = 'memory is unavailable from WSL: '

let dataDir: string
beforeEach(() => {
  dataDir = realpathSync(mkdtempSync(join(tmpdir(), 'sam-wsl-tools-')))
})
afterEach(() => {
  jest.useRealTimers()
  rmSync(dataDir, { recursive: true, force: true })
})

function writeEndpoint(info: Record<string, unknown> = { pid: PID, port: PORT }, token = TOKEN): void {
  writeFileSync(join(dataDir, 'daemon.json'), JSON.stringify(info))
  writeFileSync(join(dataDir, 'daemon.token'), `${token}\n`)
}

interface Seen {
  url: string
  init: RequestInit
}

const healthy = (): Response => Response.json({ ok: true, version: 'x', pid: PID })

/** Answers /health as the daemon unless `health` says otherwise, and every read with `read`. */
function fakeFetch(read: () => Promise<Response>, health: () => Promise<Response> = async () => healthy()): { fetch: DaemonFetch; seen: Seen[] } {
  const seen: Seen[] = []
  return {
    seen,
    fetch: (url, init) => {
      seen.push({ url, init })
      return url.endsWith('/health') ? health() : read()
    },
  }
}

interface ProbeLog {
  probes: WslProbes
  asked: string[]
}

function probes(mode: string | null, alive: boolean | null): ProbeLog {
  const asked: string[] = []
  return {
    asked,
    probes: {
      networkingMode: async () => {
        asked.push('mode')
        return mode
      },
      pidAlive: async (pid) => {
        asked.push(`pid ${pid}`)
        return alive
      },
    },
  }
}

const UNKNOWN = probes(null, null).probes

const VALID: ToolOutcome = {
  result: { content: [{ type: 'text', text: 'Found 1' }], structuredContent: { status: 'ok' } },
  count: 1,
  ids: [7],
  scope: '*',
}

const refusedError = (): Error => Object.assign(new TypeError(`connect to 127.0.0.1 with ${TOKEN}`), { code: 'ECONNREFUSED' })

function call(fetchFn: DaemonFetch, probeSet: WslProbes = UNKNOWN, name = 'search'): Promise<ToolOutcome | null> {
  return daemonToolCaller({ dataDir, cwd: CWD, fetch: fetchFn, probes: probeSet })(name, { query: 'x' })
}

function textOf(outcome: ToolOutcome | null): string {
  expect(outcome).not.toBeNull()
  expect(outcome!.result.isError).toBe(true)
  expect(outcome!.count).toBe(0)
  expect(outcome!.result.structuredContent.status).toBe('unavailable')
  const text = outcome!.result.content[0]!.text
  expect(outcome!.result.structuredContent.reason).toBe(text.slice(PREFIX.length))
  expect(JSON.stringify(outcome)).not.toContain(TOKEN)
  return text
}

test('the caller sends the args and cwd with the token, after a tokenless health check', async () => {
  writeEndpoint()
  const fake = fakeFetch(async () => Response.json({ outcome: VALID }))
  expect(await call(fake.fetch)).toEqual(VALID)
  expect(fake.seen.map((seen) => seen.url)).toEqual([`http://127.0.0.1:${PORT}/health`, `http://127.0.0.1:${PORT}/read/search`])
  const [health, read] = fake.seen as [Seen, Seen]
  expect(health.init.headers).toBeUndefined()
  expect(health.init.redirect).toBe('error')
  expect(read.init.method).toBe('POST')
  expect(read.init.redirect).toBe('error')
  expect((read.init.headers as Record<string, string>).authorization).toBe(`Bearer ${TOKEN}`)
  expect(JSON.parse(read.init.body as string)).toEqual({ args: { query: 'x' }, cwd: CWD })
})

test('every way the daemon can be missing answers with the fixed text', async () => {
  const never = fakeFetch(() => new Promise<Response>(() => {}), () => new Promise<Response>(() => {}))
  expect(textOf(await call(never.fetch))).toBe(`${PREFIX}the Windows daemon is not running (no daemon.json in ${dataDir})`)
  expect(never.seen).toHaveLength(0)

  writeEndpoint()
  const refused = fakeFetch(() => Promise.reject(refusedError()), () => Promise.reject(refusedError()))
  expect(textOf(await call(refused.fetch))).toBe(
    `${PREFIX}could not reach the Windows daemon; WSL may need mirrored networking (ECONNREFUSED on 127.0.0.1:${PORT})`,
  )

  jest.useFakeTimers()
  const pending = call(never.fetch)
  // The deadline starts once daemon.json is read; setImmediate is not faked, so this waits for the health request.
  for (let turn = 0; turn < 10_000 && never.seen.length === 0; turn += 1) await new Promise((resolve) => setImmediate(resolve))
  expect(never.seen).toHaveLength(1)
  jest.advanceTimersByTime(WSL_READ_TIMEOUT_MS + 1)
  expect(textOf(await pending)).toBe(`${PREFIX}could not reach the Windows daemon; WSL may need mirrored networking (TimeoutError on 127.0.0.1:${PORT})`)
  expect(never.seen[0]!.init.signal?.aborted).toBe(true)
  jest.useRealTimers()

  const missing = fakeFetch(async () => new Response('not found', { status: 404 }))
  expect(textOf(await call(missing.fetch))).toBe(`${PREFIX}the Windows daemon has no read routes; update Kinfold on Windows`)

  const stale = fakeFetch(async () => new Response('no', { status: 401 }))
  expect(textOf(await call(stale.fetch))).toBe(`${PREFIX}the Windows daemon on 127.0.0.1:${PORT} refused the read (HTTP 401)`)

  const garbled = fakeFetch(async () => Response.json({ outcome: { ...VALID, count: -1, leak: TOKEN } }))
  expect(textOf(await call(garbled.fetch))).toBe(`${PREFIX}the Windows daemon sent an answer this program cannot read`)
})

test('a port held by another program never receives the token', async () => {
  writeEndpoint()
  const others = [
    async () => new Response('hello', { status: 200 }),
    async () => Response.json({ ok: true, pid: PID + 1 }),
    async () => new Response(null, { status: 404 }),
    () => Promise.reject(Object.assign(new TypeError('redirected'), { code: 'UnexpectedRedirect' })),
  ]
  for (const health of others) {
    const fake = fakeFetch(async () => Response.json({ outcome: VALID }), health)
    const asked = probes('nat', false)
    expect(textOf(await call(fake.fetch, asked.probes))).toBe(`${PREFIX}the Windows daemon is not running (another program answers on 127.0.0.1:${PORT})`)
    expect(fake.seen).toHaveLength(1)
    expect(asked.asked).toEqual([])
  }
})

test('a refused, timed-out or unreachable daemon is diagnosed from the networking mode and pid', async () => {
  writeEndpoint()
  const cases: [string | null, boolean | null, string, string[]][] = [
    ['nat', true, 'WSL is in NAT mode; Kinfold needs mirrored networking (see the README)', ['mode']],
    ['mirrored', false, `the Windows daemon is not running (daemon.json in ${dataDir} names pid ${PID}, which has exited)`, ['mode', `pid ${PID}`]],
    [null, false, `the Windows daemon is not running (daemon.json in ${dataDir} names pid ${PID}, which has exited)`, ['mode', `pid ${PID}`]],
    ['mirrored', true, `could not reach the Windows daemon (ECONNREFUSED on 127.0.0.1:${PORT}); it may not be running`, ['mode', `pid ${PID}`]],
    ['mirrored', null, `could not reach the Windows daemon (ECONNREFUSED on 127.0.0.1:${PORT}); it may not be running`, ['mode', `pid ${PID}`]],
    [null, null, `could not reach the Windows daemon; WSL may need mirrored networking (ECONNREFUSED on 127.0.0.1:${PORT})`, ['mode', `pid ${PID}`]],
  ]
  for (const [mode, alive, reason, asked] of cases) {
    const fake = fakeFetch(() => Promise.reject(refusedError()), () => Promise.reject(refusedError()))
    const log = probes(mode, alive)
    expect(textOf(await call(fake.fetch, log.probes))).toBe(`${PREFIX}${reason}`)
    expect(log.asked).toEqual(asked)
  }
  for (const code of ['EHOSTUNREACH', 'ENETUNREACH', 'ETIMEDOUT']) {
    const fake = fakeFetch(async () => healthy(), () => Promise.reject(Object.assign(new TypeError('x'), { code })))
    expect(textOf(await call(fake.fetch, probes('nat', null).probes))).toBe(`${PREFIX}WSL is in NAT mode; Kinfold needs mirrored networking (see the README)`)
  }
  // Not a connection error: no networking hint and no probe.
  const odd = fakeFetch(() => Promise.reject(new TypeError('bad header')))
  const log = probes('nat', false)
  expect(textOf(await call(odd.fetch, log.probes))).toBe(`${PREFIX}the Windows daemon sent an answer this program cannot read`)
  expect(log.asked).toEqual([])
})

test('a redirect from the daemon port is never followed', async () => {
  let otherHits = 0
  const other = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => {
    otherHits += 1
    return new Response('stolen')
  } })
  const auth: (string | null)[] = []
  let healthAnswers = false
  const crafted = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: (request) => {
    auth.push(request.headers.get('authorization'))
    if (new URL(request.url).pathname === '/health' && healthAnswers) return Response.json({ ok: true, pid: PID })
    return new Response(null, { status: 307, headers: { location: `http://localhost:${other.port}/collect` } })
  } })
  try {
    writeEndpoint({ pid: PID, port: crafted.port })
    const caller = daemonToolCaller({ dataDir, cwd: CWD, probes: UNKNOWN })
    expect(textOf(await caller('search', { query: 'x' }))).toBe(`${PREFIX}the Windows daemon is not running (another program answers on 127.0.0.1:${crafted.port})`)
    expect(auth).toEqual([null])

    healthAnswers = true
    expect(textOf(await caller('search', { query: 'x' }))).toBe(`${PREFIX}the Windows daemon sent an answer this program cannot read`)
    expect(auth).toEqual([null, null, `Bearer ${TOKEN}`])
    expect(otherHits).toBe(0)
  } finally {
    crafted.stop(true)
    other.stop(true)
  }
})

test('a daemon.json or token that cannot be trusted is never followed', async () => {
  const fake = fakeFetch(async () => Response.json({ outcome: VALID }))
  const unusable = `${PREFIX}the Windows daemon's daemon.json or daemon.token in ${dataDir} cannot be used; run kinfold status on Windows`
  const infos = [{ pid: PID, port: 80 }, { pid: PID, port: 70_000 }, { pid: PID, port: 37_811.5 }, { pid: PID, port: PORT, host: '10.0.0.2' }, { pid: -1, port: PORT }]
  for (const info of infos) {
    writeEndpoint(info)
    expect(textOf(await call(fake.fetch))).toBe(unusable)
  }
  for (const token of ['  ', 'two words', 'line\rbreak']) {
    writeEndpoint({ pid: PID, port: PORT }, token)
    expect(textOf(await call(fake.fetch))).toBe(unusable)
  }
  writeFileSync(join(dataDir, 'daemon.json'), '{"port":')
  expect(textOf(await call(fake.fetch))).toBe(unusable)
  rmSync(join(dataDir, 'daemon.token'))
  writeFileSync(join(dataDir, 'daemon.json'), JSON.stringify({ pid: PID, port: PORT }))
  expect(textOf(await call(fake.fetch))).toBe(unusable)
  expect(fake.seen).toHaveLength(0)
})

test('a wedged data folder cannot hang the call', async () => {
  if (process.platform === 'win32') return
  const fifo = join(dataDir, 'daemon.json')
  execFileSync('mkfifo', [fifo])
  const fake = fakeFetch(async () => Response.json({ outcome: VALID }))
  try {
    const started = performance.now()
    expect(textOf(await call(fake.fetch))).toBe(`${PREFIX}the Windows data folder ${dataDir} did not answer within ${WSL_FILE_TIMEOUT_MS / 1_000} s`)
    expect(performance.now() - started).toBeLessThan(WSL_FILE_TIMEOUT_MS + 1_000)
    expect(fake.seen).toHaveLength(0)
  } finally {
    // Releases the blocked read so no worker thread outlives the test.
    writeFileSync(fifo, '{}')
  }
})

test('an answer larger than the cap is not read', async () => {
  writeEndpoint()
  const chunk = new Uint8Array(1024 * 1024)
  const huge = fakeFetch(async () => {
    let sent = 0
    const body = new ReadableStream<Uint8Array>({
      pull: (controller) => {
        sent += chunk.byteLength
        if (sent > MAX_ANSWER_BYTES + chunk.byteLength) controller.close()
        else controller.enqueue(chunk)
      },
    })
    return new Response(body, { status: 200 })
  })
  expect(textOf(await call(huge.fetch))).toBe(`${PREFIX}the Windows daemon sent an answer this program cannot read`)
})

test('an unknown tool never reaches the daemon', async () => {
  writeEndpoint()
  const fake = fakeFetch(async () => Response.json({ outcome: VALID }))
  expect(await call(fake.fetch, UNKNOWN, 'ingest')).toBeNull()
  expect(await call(fake.fetch, UNKNOWN, 'read/../metrics')).toBeNull()
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
    dataDir: temp.dataDir, cwd: temp.dataDir, git: gitForProjectA, reporter, call: daemonToolCaller({ dataDir: temp.dataDir, cwd: temp.dataDir, probes: UNKNOWN }),
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
