// MCP tool calls answered by the Windows daemon's /read/ routes, for an MCP
// server running in WSL whose data folder lives on a Windows drive. memory.db
// is never opened from WSL: SQLite locking does not hold across the drive
// mount, and the daemon already owns the store. The daemon is found through
// daemon.json and daemon.token in the Windows data folder. Any failure to
// reach it answers with a fixed "unavailable" outcome that names a reason and
// carries no memory; the token never appears in an outcome.

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { readDaemonEndpoint } from '../daemon/daemon-info'
import { READ_TOOLS } from '../daemon/read-routes'
import type { ToolCaller, ToolOutcome, ToolResult } from '../mcp/tools'
import { DAEMON_INFO_FILE } from '../store/data-dir'

export const WSL_READ_TIMEOUT_MS = 5_000

const LOOPBACK = '127.0.0.1'
const MIN_PORT = 1_024
const MAX_PORT = 65_535
const PREFIX = 'memory is unavailable from WSL: '
const ERROR_NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/

export type DaemonFetch = (url: string, init: RequestInit) => Promise<Response>

export interface DaemonToolsOptions {
  dataDir: string
  cwd: string
  fetch?: DaemonFetch
}

interface Endpoint {
  port: number
  token: string
}

interface Answer {
  status: number
  body: unknown
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const isCount = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 0

export function unavailableOutcome(reason: string): ToolOutcome {
  const result: ToolResult = {
    content: [{ type: 'text', text: `${PREFIX}${reason}` }],
    structuredContent: { status: 'unavailable', reason },
    isError: true,
  }
  return { result, count: 0 }
}

function parseContent(value: unknown): ToolResult['content'] | null {
  if (!Array.isArray(value)) return null
  const content: ToolResult['content'] = []
  for (const item of value) {
    if (!isRecord(item) || item.type !== 'text' || typeof item.text !== 'string') return null
    content.push({ type: 'text', text: item.text })
  }
  return content
}

function parseResult(value: unknown): ToolResult | null {
  if (!isRecord(value)) return null
  const content = parseContent(value.content)
  const { structuredContent, isError } = value
  if (content === null || !isRecord(structuredContent)) return null
  if (isError !== undefined && typeof isError !== 'boolean') return null
  return isError === undefined ? { content, structuredContent } : { content, structuredContent, isError }
}

const isIdList = (value: unknown): value is number[] => Array.isArray(value) && value.every((id) => Number.isInteger(id))

/** A ToolOutcome rebuilt from the daemon's JSON, keeping only checked fields; null when any field is off. */
export function parseToolOutcome(value: unknown): ToolOutcome | null {
  if (!isRecord(value)) return null
  const result = parseResult(value.result)
  const { count, ids, scope } = value
  if (result === null || !isCount(count)) return null
  if (ids !== undefined && !isIdList(ids)) return null
  if (scope !== undefined && typeof scope !== 'string') return null
  return { result, count, ...(ids !== undefined ? { ids } : {}), ...(scope !== undefined ? { scope } : {}) }
}

// daemon.json names no host today; one that names anything but loopback is refused rather than followed.
function readEndpoint(dataDir: string): Endpoint | null {
  const endpoint = readDaemonEndpoint(dataDir)
  if (endpoint === null || endpoint.port < MIN_PORT || endpoint.port > MAX_PORT) return null
  try {
    const info: unknown = JSON.parse(readFileSync(join(dataDir, DAEMON_INFO_FILE), 'utf8'))
    if (!isRecord(info) || info.port !== endpoint.port) return null
    if (info.host !== undefined && info.host !== LOOPBACK) return null
  } catch {
    // Rewritten between the two reads: treated like any unusable file.
    return null
  }
  return endpoint
}

// Bun names a refused connection by its code, other errors by class; neither carries the URL or headers.
function errorName(error: unknown): string {
  if (!(error instanceof Error)) return 'Error'
  const { code } = error as { code?: unknown }
  if (typeof code === 'string' && ERROR_NAME.test(code)) return code
  return ERROR_NAME.test(error.name) ? error.name : 'Error'
}

class ReadTimeoutError extends Error {
  override name = 'TimeoutError'
}

async function post(url: string, init: RequestInit, fetchFn: DaemonFetch): Promise<Answer> {
  const response = await fetchFn(url, init)
  if (response.status !== 200) return { status: response.status, body: null }
  try {
    return { status: 200, body: await response.json() }
  } catch {
    // Not JSON: the outcome check below reports it as unreadable.
    return { status: 200, body: null }
  }
}

// The timer races the fetch itself, so a fetch that ignores the abort signal still cannot hang the agent.
async function postWithTimeout(url: string, init: RequestInit, fetchFn: DaemonFetch): Promise<Answer> {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort()
      reject(new ReadTimeoutError())
    }, WSL_READ_TIMEOUT_MS)
  })
  try {
    return await Promise.race([post(url, { ...init, signal: controller.signal }, fetchFn), timeout])
  } finally {
    clearTimeout(timer)
  }
}

function outcomeFor(answer: Answer, port: number): ToolOutcome {
  if (answer.status === 404) return unavailableOutcome('the Windows daemon has no read routes; update Kinfold on Windows')
  if (answer.status !== 200) return unavailableOutcome(`the Windows daemon on ${LOOPBACK}:${port} refused the read (HTTP ${answer.status})`)
  const outcome = isRecord(answer.body) ? parseToolOutcome(answer.body.outcome) : null
  return outcome ?? unavailableOutcome('the Windows daemon sent an answer this program cannot read')
}

const isReadTool = (name: string): boolean => (READ_TOOLS as readonly string[]).includes(name)

export function daemonToolCaller(options: DaemonToolsOptions): ToolCaller {
  const fetchFn = options.fetch ?? ((url: string, init: RequestInit) => fetch(url, init))
  return async (name, args) => {
    if (!isReadTool(name)) return null
    if (!existsSync(join(options.dataDir, DAEMON_INFO_FILE))) {
      return unavailableOutcome(`the Windows daemon is not running (no daemon.json in ${options.dataDir})`)
    }
    const endpoint = readEndpoint(options.dataDir)
    if (endpoint === null) {
      return unavailableOutcome(`the Windows daemon's daemon.json or daemon.token in ${options.dataDir} cannot be used; run kinfold status on Windows`)
    }
    const init: RequestInit = {
      method: 'POST',
      headers: { authorization: `Bearer ${endpoint.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ args, cwd: options.cwd }),
    }
    try {
      return outcomeFor(await postWithTimeout(`http://${LOOPBACK}:${endpoint.port}/read/${name}`, init, fetchFn), endpoint.port)
    } catch (error: unknown) {
      // Under NAT networking WSL's 127.0.0.1 is its own, so the Windows daemon never answers there.
      const reason = `the Windows daemon did not answer on ${LOOPBACK}:${endpoint.port} (${errorName(error)}). WSL (preview) needs mirrored networking; run kinfold status in WSL`
      return unavailableOutcome(reason)
    }
  }
}
