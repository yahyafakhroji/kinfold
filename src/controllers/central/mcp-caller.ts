// MCP tool calls on a central device. The memory is on the hub, so the MCP
// server asks this device's daemon over loopback (the /read/ routes, with
// the data-folder token), and the daemon's relay asks the hub. Any failure is
// an answer with no memory that says why.

import { readDaemonEndpoint } from '../daemon/daemon-info'
import { READ_TOOLS } from '../daemon/read-routes'
import type { ToolCaller, ToolOutcome } from '../mcp/tools'
import { parseToolOutcome, unavailableOutcome } from '../mcp/outcome'

export const CENTRAL_READ_TIMEOUT_MS = 6_000

export type CallerFetch = (url: string, init: RequestInit) => Promise<Response>

export interface CentralCallerOptions {
  dataDir: string
  cwd: string
  fetch?: CallerFetch
  timeoutMs?: number
}

const unavailable = (reason: string): ToolOutcome => unavailableOutcome('central memory is unavailable: ', reason)

const DAEMON_DOWN = 'the Kinfold daemon on this device is not running (kinfold status says why)'

export function centralToolCaller(options: CentralCallerOptions): ToolCaller {
  const fetchFn = options.fetch ?? ((url: string, init: RequestInit) => fetch(url, init))
  return async (name, args) => {
    if (!(READ_TOOLS as readonly string[]).includes(name)) return null
    const endpoint = readDaemonEndpoint(options.dataDir)
    if (endpoint === null) return unavailable(DAEMON_DOWN)
    let response: Response
    try {
      response = await fetchFn(`http://127.0.0.1:${endpoint.port}/read/${name}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${endpoint.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ args, cwd: options.cwd }),
        redirect: 'error',
        signal: AbortSignal.timeout(options.timeoutMs ?? CENTRAL_READ_TIMEOUT_MS),
      })
    } catch (error: unknown) {
      const name = error instanceof Error ? error.name : ''
      return unavailable(name === 'TimeoutError' || name === 'AbortError' ? 'the daemon on this device did not answer in time' : DAEMON_DOWN)
    }
    if (response.status !== 200) return unavailable(`the daemon on this device refused the read (HTTP ${response.status})`)
    const body: unknown = await response.json().catch(() => null)
    const outcome = typeof body === 'object' && body !== null ? parseToolOutcome((body as { outcome?: unknown }).outcome) : null
    return outcome ?? unavailable('the daemon on this device sent an answer this program cannot read')
  }
}
