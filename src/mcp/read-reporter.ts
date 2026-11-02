// Reports each answered MCP tool call to the daemon, so hit rate can
// count what agents fetched. The MCP server stays read-only: it never
// opens the database for writing; it posts POST /metrics/mcp-read with the
// daemon token from the data dir and the daemon writes the row. Fire and
// forget: report() schedules the post after the reply has been written and
// returns at once, the post has a 200 ms timeout, and a daemon that is down,
// slow or refusing only adds one to the drop count, which the tool log line
// shows. The report carries the tool, scope, returned ids and counts; never
// the query, arguments or any text.

import { readDaemonEndpoint } from '../daemon/daemon-info'
import { envName, readEnv } from '../env-names'
import type { McpRead } from '../store/mcp-read-store'

export const REPORT_TIMEOUT_MS = 200
/** The env var each host's MCP entry sets to name itself (src/install/mcp-config.ts). */
export const MCP_HOST_ENV = envName('MCP_HOST')
/** Same cap the daemon enforces. */
export const MAX_REPORTED_IDS = 100

const HOST_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/

export type ReportFetch = (url: string, init: RequestInit) => Promise<Response>

export interface ReadReporterOptions {
  dataDir: string
  host: string | null
  fetch?: ReportFetch
  timeoutMs?: number
  /** Test seam: when the post starts. The default waits one macrotask, after the reply is written. */
  schedule?: (task: () => void) => void
}

export interface ReadReporter {
  report: (read: Omit<McpRead, 'host'>) => void
  /** Reports that never reached the daemon since start. */
  drops: () => number
  /** Resolves once every report started so far has settled (tests and shutdown). */
  settled: () => Promise<void>
}

/** KINFOLD_MCP_HOST (or legacy SAM_MCP_HOST) when it is a short lowercase name, else null. */
export function hostFromEnv(env: Readonly<Record<string, string | undefined>>): string | null {
  const value = readEnv(env, 'MCP_HOST')
  return value !== undefined && HOST_PATTERN.test(value) ? value : null
}

export function createReadReporter(options: ReadReporterOptions): ReadReporter {
  const fetchFn = options.fetch ?? fetch
  const timeoutMs = options.timeoutMs ?? REPORT_TIMEOUT_MS
  const schedule = options.schedule ?? ((task: () => void) => void setTimeout(task, 0))
  const inFlight = new Set<Promise<void>>()
  let dropped = 0

  const post = async (read: Omit<McpRead, 'host'>): Promise<void> => {
    const endpoint = readDaemonEndpoint(options.dataDir)
    if (endpoint === null) {
      dropped += 1
      return
    }
    try {
      const body = { ...read, host: options.host, returnedIds: read.returnedIds.slice(0, MAX_REPORTED_IDS), ms: Math.max(0, read.ms) }
      const response = await fetchFn(`http://127.0.0.1:${endpoint.port}/metrics/mcp-read`, {
        method: 'POST',
        headers: { authorization: `Bearer ${endpoint.token}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      })
      if (response.status !== 201) dropped += 1
    } catch {
      // Down, slow or refused: the count is the only trace, by design.
      dropped += 1
    }
  }

  const report = (read: Omit<McpRead, 'host'>): void => {
    let release = (): void => {}
    const done = new Promise<void>((resolve) => {
      release = resolve
    })
    inFlight.add(done)
    schedule(() => {
      post(read).catch(() => {
        dropped += 1
      }).finally(() => {
        inFlight.delete(done)
        release()
      })
    })
  }

  return { report, drops: () => dropped, settled: async () => void (await Promise.all([...inFlight])) }
}
