// MCP tool calls answered by the Windows daemon's /read/ routes, for an MCP
// server running in WSL whose data folder lives on a Windows drive. memory.db
// is never opened from WSL: SQLite locking does not hold across the drive
// mount, and the daemon already owns the store.
//
// The daemon is found through daemon.json and daemon.token in the Windows
// data folder, read asynchronously under a timeout so a wedged drive mount
// cannot hang the agent. Every request goes to 127.0.0.1, never follows a
// redirect, and is bounded by one deadline. Before the token is sent, a
// tokenless GET /health must answer as a Kinfold daemon with the pid
// daemon.json names, so a stale daemon.json whose port another program now
// holds never receives the token. Any failure answers with a fixed
// "unavailable" outcome that names a reason and carries no memory; the token
// never appears in an outcome.

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { READ_TOOLS } from '../daemon/read-routes'
import { parseToolOutcome, unavailableOutcome as unavailable } from '../mcp/outcome'
import type { ToolCaller, ToolOutcome } from '../mcp/tools'
import { DAEMON_INFO_FILE, TOKEN_FILE } from '../store/data-dir'
import { type WslProbes, defaultWslProbes } from './wsl-probes'
import { isRecord } from '../contract/event'
import { errorCode } from '../errors'
import { MAX_ANSWER_BYTES, readCappedJson } from '../http/capped'
import { MAX_PORT } from '../daemon/port'

export const WSL_READ_TIMEOUT_MS = 5_000
/** A drive mount that has not answered by then is treated as wedged. */
export const WSL_FILE_TIMEOUT_MS = 2_000
export { MAX_ANSWER_BYTES, parseToolOutcome }

const LOOPBACK = '127.0.0.1'
const MIN_PORT = 1_024
const PREFIX = 'memory is unavailable from WSL: '
const ERROR_NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/
const HEADER_SAFE = /^[\x21-\x7e]+$/
const CONNECTION_CODES = new Set([
  'ECONNREFUSED', 'ConnectionRefused', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH', 'EHOSTDOWN', 'ENETDOWN', 'EADDRNOTAVAIL', 'FailedToOpenSocket',
])

export type DaemonFetch = (url: string, init: RequestInit) => Promise<Response>

export interface DaemonToolsOptions {
  dataDir: string
  cwd: string
  fetch?: DaemonFetch
  /** Asked only after the daemon could not be reached; tests pass fixed answers. */
  probes?: WslProbes
}

interface DaemonFiles {
  port: number
  /** Null when daemon.json names none; then /health's pid is not compared. */
  pid: number | null
  token: string
}

type Read<T> = { ok: true; value: T } | { ok: false; outcome: ToolOutcome }

interface Answer {
  status: number
  body: unknown
}

/** The MCP answer when WSL cannot reach the Windows daemon. */
export const unavailableOutcome = (reason: string): ToolOutcome => unavailable(PREFIX, reason)

class TimeoutError extends Error {
  override name = 'TimeoutError'
}

/** Races a promise against a timer; the loser is left to settle on its own. */
async function within<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TimeoutError()), ms)
  })
  try {
    return await Promise.race([promise, timeout])
  } finally {
    clearTimeout(timer)
  }
}

async function readOptional(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8')
  } catch (error: unknown) {
    if (errorCode(error) === 'ENOENT') return null
    throw error
  }
}

// daemon.json names no host today; one that names anything but loopback is refused rather than followed.
function parseFiles(infoText: string, tokenText: string | null): DaemonFiles | null {
  const info: unknown = JSON.parse(infoText)
  if (!isRecord(info)) return null
  const { port, pid, host } = info
  if (typeof port !== 'number' || !Number.isInteger(port) || port < MIN_PORT || port > MAX_PORT) return null
  if (host !== undefined && host !== LOOPBACK) return null
  if (pid !== undefined && !(typeof pid === 'number' && Number.isSafeInteger(pid) && pid > 0)) return null
  const token = tokenText?.trim() ?? ''
  if (!HEADER_SAFE.test(token)) return null
  return { port, pid: pid === undefined ? null : pid, token }
}

async function readDaemonFiles(dataDir: string): Promise<Read<DaemonFiles>> {
  let texts: [string | null, string | null]
  try {
    texts = await within(Promise.all([readOptional(join(dataDir, DAEMON_INFO_FILE)), readOptional(join(dataDir, TOKEN_FILE))]), WSL_FILE_TIMEOUT_MS)
  } catch (error: unknown) {
    if (error instanceof TimeoutError) {
      return { ok: false, outcome: unavailableOutcome(`the Windows data folder ${dataDir} did not answer within ${WSL_FILE_TIMEOUT_MS / 1_000} s`) }
    }
    texts = ['', null]
  }
  const [infoText, tokenText] = texts
  if (infoText === null) return { ok: false, outcome: unavailableOutcome(`the Windows daemon is not running (no daemon.json in ${dataDir})`) }
  let files: DaemonFiles | null = null
  try {
    files = parseFiles(infoText, tokenText)
  } catch {
    // Half-written JSON reads like any unusable file.
  }
  if (files === null) {
    return { ok: false, outcome: unavailableOutcome(`the Windows daemon's daemon.json or daemon.token in ${dataDir} cannot be used; run kinfold status on Windows`) }
  }
  return { ok: true, value: files }
}

/** One deadline for the whole call: every step races the same timer and shares one abort signal. */
interface Deadline {
  run: <T>(step: (signal: AbortSignal) => Promise<T>) => Promise<T>
  clear: () => void
}

function startDeadline(ms: number): Deadline {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort()
      reject(new TimeoutError())
    }, ms)
  })
  expired.catch(() => {})
  return {
    // The timer races the step itself, so a fetch that ignores the abort signal still cannot hang the agent.
    run: (step) => Promise.race([step(controller.signal), expired]),
    clear: () => clearTimeout(timer),
  }
}

function isConnectionError(error: unknown): boolean {
  const code = errorCode(error)
  return error instanceof TimeoutError || (typeof code === 'string' && CONNECTION_CODES.has(code))
}

/** True only for a Kinfold daemon with daemon.json's pid; a non-connection failure means some other program. */
async function isOurDaemon(base: string, files: DaemonFiles, fetchFn: DaemonFetch, signal: AbortSignal): Promise<boolean> {
  try {
    const response = await fetchFn(`${base}/health`, { method: 'GET', redirect: 'error', signal })
    const body = response.status === 200 ? await readCappedJson(response, MAX_ANSWER_BYTES) : null
    return isRecord(body) && body.ok === true && (files.pid === null || body.pid === files.pid)
  } catch (error: unknown) {
    if (isConnectionError(error)) throw error
    return false
  }
}

async function postRead(url: string, init: RequestInit, fetchFn: DaemonFetch): Promise<Answer> {
  try {
    const response = await fetchFn(url, init)
    return { status: response.status, body: response.status === 200 ? await readCappedJson(response, MAX_ANSWER_BYTES) : null }
  } catch (error: unknown) {
    if (isConnectionError(error)) throw error
    // A redirect or a broken answer after the handshake: unreadable, never followed.
    return { status: 200, body: null }
  }
}

function outcomeFor(answer: Answer, port: number): ToolOutcome {
  if (answer.status === 404) return unavailableOutcome('the Windows daemon has no read routes; update Kinfold on Windows')
  if (answer.status !== 200) return unavailableOutcome(`the Windows daemon on ${LOOPBACK}:${port} refused the read (HTTP ${answer.status})`)
  const outcome = isRecord(answer.body) ? parseToolOutcome(answer.body.outcome) : null
  return outcome ?? unavailableOutcome('the Windows daemon sent an answer this program cannot read')
}

// Bun names a refused connection by its code, other errors by class; neither carries the URL or headers.
function errorName(error: unknown): string {
  const code = errorCode(error)
  if (typeof code === 'string' && ERROR_NAME.test(code)) return code
  return error instanceof Error && ERROR_NAME.test(error.name) ? error.name : 'Error'
}

/** Why a refused, timed-out or unreachable connection failed, as far as WSL can tell. */
async function unreachableOutcome(error: unknown, files: DaemonFiles, dataDir: string, probes: WslProbes): Promise<ToolOutcome> {
  const where = `${errorName(error)} on ${LOOPBACK}:${files.port}`
  const mode = await probes.networkingMode()
  // Under NAT, WSL's 127.0.0.1 is its own, so a Windows daemon can never answer there.
  if (mode === 'nat') return unavailableOutcome('WSL is in NAT mode; Kinfold needs mirrored networking (see the README)')
  if (files.pid !== null && (await probes.pidAlive(files.pid)) === false) {
    return unavailableOutcome(`the Windows daemon is not running (daemon.json in ${dataDir} names pid ${files.pid}, which has exited)`)
  }
  if (mode === 'mirrored') return unavailableOutcome(`could not reach the Windows daemon (${where}); it may not be running`)
  return unavailableOutcome(`could not reach the Windows daemon; WSL may need mirrored networking (${where})`)
}

const isReadTool = (name: string): boolean => (READ_TOOLS as readonly string[]).includes(name)

export function daemonToolCaller(options: DaemonToolsOptions): ToolCaller {
  const fetchFn = options.fetch ?? ((url: string, init: RequestInit) => fetch(url, init))
  const probes = options.probes ?? defaultWslProbes
  return async (name, args) => {
    if (!isReadTool(name)) return null
    const read = await readDaemonFiles(options.dataDir)
    if (!read.ok) return read.outcome
    const files = read.value
    const base = `http://${LOOPBACK}:${files.port}`
    const deadline = startDeadline(WSL_READ_TIMEOUT_MS)
    try {
      if (!(await deadline.run((signal) => isOurDaemon(base, files, fetchFn, signal)))) {
        return unavailableOutcome(`the Windows daemon is not running (another program answers on ${LOOPBACK}:${files.port})`)
      }
      const answer = await deadline.run((signal) => postRead(`${base}/read/${name}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${files.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ args, cwd: options.cwd }),
        redirect: 'error',
        signal,
      }, fetchFn))
      return outcomeFor(answer, files.port)
    } catch (error: unknown) {
      if (isConnectionError(error)) return await unreachableOutcome(error, files, options.dataDir, probes)
      return unavailableOutcome('the Windows daemon sent an answer this program cannot read')
    } finally {
      deadline.clear()
    }
  }
}
