// The load beside src/daemon/recall.bench.test.ts, in a process of its own as
// in real use: hooks and the dashboard are separate processes from the daemon,
// and run in the test's own process their file writes and requests took the
// daemon's thread. Args: data dir, port, token, the project folder. Runs until
// it is killed.
//   Captures: another agent at work, ten tool events every 40 ms and a turn end
//   every fourth batch, each batch nudging the drain.
//   Dashboard: the Data, Metrics and Memory pages opened over and over. The
//   pages read size, metrics and facets when opened and never poll them, so a
//   read every 500 ms is far busier than a person clicking through.

import { join } from 'node:path'
import { captureEvent } from '../src/capture/capture'
import { type NormalizedEvent, SCHEMA_VERSION } from '../src/contract/event'
import { ulid } from '../src/contract/ulid'
import { SPOOL_DIR } from '../src/store/data-dir'
import { benchWords } from './recall-bench-words'

const [dataDir, port, token, cwd] = process.argv.slice(2)
if (dataDir === undefined || port === undefined || token === undefined || cwd === undefined) throw new Error('usage: recall-bench-load.ts <dataDir> <port> <token> <cwd>')

const DASHBOARD_PAUSE_MS = 500
const CAPTURE_PAUSE_MS = 40
const REQUEST_TIMEOUT_MS = 15_000
const { sentence } = benchWords(11)
const spoolDir = join(dataDir, SPOOL_DIR)

async function call(method: string, path: string): Promise<void> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
    await response.arrayBuffer()
  } catch {
    // A slow or failed read is the daemon's problem to show in the prompt times, not this process's.
  }
}

let clock = Date.now()
function event(overrides: Partial<NormalizedEvent>): NormalizedEvent {
  clock += 1
  return { schemaVersion: SCHEMA_VERSION, eventId: ulid(clock), host: 'claude-code', hostSessionId: 'busy-session', kind: 'tool_result', occurredAt: clock, cwd, ...overrides } as NormalizedEvent
}

async function captures(): Promise<never> {
  for (let turn = 1; ; turn += 1) {
    for (let index = 0; index < 10; index += 1) {
      captureEvent(event({ kind: 'tool_result', tool: { name: 'Bash', input: { command: `echo ${sentence(20)}` }, output: sentence(80) } } as Partial<NormalizedEvent>), { spoolDir, hmacKey: 'bench' })
    }
    if (turn % 4 === 0) captureEvent(event({ kind: 'turn_end' }), { spoolDir, hmacKey: 'bench' })
    await call('POST', '/spool/nudge')
    await Bun.sleep(CAPTURE_PAUSE_MS)
  }
}

async function dashboard(): Promise<never> {
  for (;;) {
    for (const path of ['/data/size', '/metrics/summary?window=7d', '/memory/facets']) {
      await call('GET', path)
      await Bun.sleep(DASHBOARD_PAUSE_MS)
    }
  }
}

process.stdout.write('load running\n')
await Promise.all([captures(), dashboard()])
