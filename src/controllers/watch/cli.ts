// `kinfold watch [--host <agent>] [--project <name>] [--debug [--json]]`: what
// Kinfold recalled, live, for every agent: one line per prompt with the time,
// the agent and the project. It is the view for agents that cannot show the
// line themselves. --debug reads the daemon's in-memory trace instead: why
// each recall came out as it did, the turn's usage and the observer's runs;
// --json prints those events as JSON, one per line, for scripts.
// It polls the daemon's authenticated route once a second and starts from
// now. A daemon that stops answering is waited for; Ctrl-C ends the watch
// with exit 0. Lines go through `env.out`, so a terminal gets the CLI's framed
// look and a pipe gets plain lines.

import { HELD_OUT_LINE, type Recalled, cleanTitle, lateLine, recallLine } from '../../resources/context/recall-line'
import { isRecord } from '../../system/contract/event'
import { readDaemonEndpoint } from '../daemon/daemon-info'
import type { WatchArgs } from '../install/args'
import type { InstallEnv } from '../../resources/install-plan/env'
import type { WatchRow } from './reads'
import { debugLines, parseDebugEvent } from './debug'

export type WatchEnv = Pick<InstallEnv, 'dataDir' | 'fetch' | 'out' | 'sleep'> & Partial<Pick<InstallEnv, 'ui'>>

export interface WatchDeps {
  /** Aborted by Ctrl-C; the watch then ends with 0. Absent: the watch runs until its process is ended. */
  stop?: AbortSignal
  pollMs?: number
}

const EXIT_OK = 0
const EXIT_FAILED = 1
export const WATCH_POLL_MS = 1_000
const REQUEST_TIMEOUT_MS = 5_000
const PREFIX = 'kinfold · '

function clock(at: number): string {
  const date = new Date(at)
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

/** What this command reads of a row. Its line is built here from the ids and titles, so the daemon's ready-made `line` is not used. */
export type ShownRow = Pick<WatchRow, 'id' | 'at' | 'host' | 'project' | 'ids' | 'recalled' | 'heldOut'> & Partial<Pick<WatchRow, 'late'>>

/** `HH:MM  agent · project · what was recalled`, in the reader's own time zone. */
export function formatWatchLine(row: ShownRow): string {
  const recall = recallLine(row.ids, row.recalled)
  const line = row.heldOut ? HELD_OUT_LINE : row.late === true ? lateLine(recall) : recall
  return `${clock(row.at)}  ${cleanTitle(row.host)} · ${cleanTitle(row.project)} · ${line.startsWith(PREFIX) ? line.slice(PREFIX.length) : line}`
}

function parseRow(value: unknown): ShownRow | null {
  if (!isRecord(value)) return null
  const { id, at, host, project, ids, recalled, heldOut, late } = value
  if (!Number.isSafeInteger(id) || !Number.isSafeInteger(at) || typeof host !== 'string' || typeof project !== 'string' || !Array.isArray(ids)) return null
  if (!ids.every((entry) => Number.isSafeInteger(entry))) return null
  const titles = Array.isArray(recalled)
    ? recalled.flatMap((entry) => (isRecord(entry) && Number.isSafeInteger(entry.id) && typeof entry.title === 'string' && (entry.part === 'new' || entry.part === 'related')
        ? [{ id: entry.id as number, title: entry.title, part: entry.part as Recalled['part'] }] : []))
    : []
  return { id: id as number, at: at as number, host, project, ids: ids as number[], recalled: titles, heldOut: heldOut === true, late: late === true }
}

/** The update the user is owed, as the dashboard banner says it; null for none. */
type Update = { version: string; message: string } | null
type Poll = { kind: 'rows'; cursor: number; lines: string[]; update: Update; epoch?: string; merges?: string[] } | { kind: 'old' } | { kind: 'down' }

/** What one route answers and how its answer becomes lines: the prompt rows, or the debug trace. */
interface Source {
  path: string
  /** Null for an answer of the wrong shape. */
  read(body: Record<string, unknown>): { cursor: number; lines: string[]; update: Update; epoch?: string; merges?: string[] } | null
  /** Why a 404 means the daemon is too old for this view. */
  missing: string
}

const ROWS: Source = {
  path: '/watch',
  read: (body) => (!Number.isSafeInteger(body.cursor) || !Array.isArray(body.rows) ? null
    : { cursor: body.cursor as number, lines: body.rows.flatMap((row) => parseRow(row) ?? []).map(formatWatchLine), update: parseUpdate(body.update), merges: mergeLines(body.merges) }),
  missing: 'the running daemon is an older build without watch; run kinfold update',
}

function traceSource(json: boolean): Source {
  return {
    path: '/watch/debug',
    read: (body) => {
      if (!Number.isSafeInteger(body.cursor) || !Array.isArray(body.events)) return null
      const events = body.events.flatMap((event) => parseDebugEvent(event) ?? [])
      return { cursor: body.cursor as number, lines: events.flatMap((event) => (json ? [JSON.stringify(event)] : debugLines(event))), update: null,
        ...(typeof body.epoch === 'string' ? { epoch: body.epoch } : {}) }
    },
    missing: 'the running daemon is an older build without watch --debug; run kinfold update',
  }
}

/** "kinfold · merged <old> into <new> (same repo)" for each merge the route lists; an older daemon lists none. */
function mergeLines(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((merge) => {
    if (!isRecord(merge) || typeof merge.from !== 'string' || typeof merge.into !== 'string') return []
    return [`kinfold · merged ${cleanTitle(merge.from)} into ${cleanTitle(merge.into)} (${merge.reason === 'same-repo' ? 'same repo' : 'kinfold project merge'})`]
  })
}

function parseUpdate(value: unknown): Update {
  if (!isRecord(value) || typeof value.version !== 'string' || typeof value.message !== 'string') return null
  return { version: value.version, message: cleanTitle(value.message) }
}

async function poll(env: WatchEnv, source: Source, port: number, token: string, args: WatchArgs, cursor: number | null, stop?: AbortSignal): Promise<Poll> {
  const query = new URLSearchParams()
  if (cursor !== null) query.set('after', String(cursor))
  if (args.host !== null) query.set('host', args.host)
  if (args.project !== null) query.set('project', args.project)
  const search = query.toString()
  try {
    const response = await env.fetch(`http://127.0.0.1:${port}${source.path}${search === '' ? '' : `?${search}`}`, {
      headers: { authorization: `Bearer ${token}` },
      // Ctrl-C ends a request in flight too, so the command stops at once and not at its timeout.
      signal: stop === undefined ? AbortSignal.timeout(REQUEST_TIMEOUT_MS) : AbortSignal.any([AbortSignal.timeout(REQUEST_TIMEOUT_MS), stop]),
    })
    if (response.status === 404) return { kind: 'old' }
    if (response.status !== 200) return { kind: 'down' }
    const body: unknown = await response.json()
    const read = isRecord(body) ? source.read(body) : null
    return read === null ? { kind: 'down' } : { kind: 'rows', ...read }
  } catch {
    return { kind: 'down' }
  }
}

function heading(args: WatchArgs): string {
  const who = args.host ?? 'every agent'
  const where = `${who}${args.project === null ? '' : ` in ${cleanTitle(args.project)}`}`
  return args.debug ? `watching ${where} with the reasons behind each recall; Ctrl-C to stop` : `watching ${where}; one line per prompt, Ctrl-C to stop`
}

/** Resolves after `ms`, or at once when the watch is stopped. */
function pause(env: WatchEnv, ms: number, stop: AbortSignal | undefined): Promise<void> {
  if (stop === undefined) return env.sleep(ms)
  if (stop.aborted) return Promise.resolve()
  return new Promise((resolve) => {
    const done = (): void => {
      stop.removeEventListener('abort', done)
      resolve()
    }
    stop.addEventListener('abort', done)
    void env.sleep(ms).then(done)
  })
}

export async function runWatch(env: WatchEnv, args: WatchArgs, deps: WatchDeps = {}): Promise<number> {
  const fail = (reason: string): number => {
    ;(env.ui?.error ?? env.out)(`kinfold watch failed: ${reason}`)
    return EXIT_FAILED
  }
  const endpoint = readDaemonEndpoint(env.dataDir)
  if (endpoint === null) return fail('the daemon is not running (no daemon.json or daemon.token)')
  const source = args.debug ? traceSource(args.json) : ROWS
  // JSON output is for scripts: every line on stdout is one event, so nothing else is printed there.
  const say = args.json ? (): void => {} : (line: string): void => env.out(line)
  const first = await poll(env, source, endpoint.port, endpoint.token, args, null)
  if (first.kind === 'old') return fail(source.missing)
  if (first.kind === 'down') return fail('the daemon is not answering')
  say(heading(args))
  env.ui?.next('Stopped watching.')

  let cursor = first.cursor
  let epoch = first.epoch
  let waiting = false
  // Each notice is printed once per watch, on its own line; a new one replaces it.
  let shown: string | null = null
  const showUpdate = (update: Update): void => {
    if (update === null || update.message === shown) return
    shown = update.message
    say(update.message)
  }
  showUpdate(first.update)
  // Each project merge is said once per watch, whichever poll carries it.
  const merged = new Set<string>()
  const showMerges = (lines: readonly string[] | undefined): void => {
    for (const line of lines ?? []) {
      if (merged.has(line)) continue
      merged.add(line)
      say(line)
    }
  }
  showMerges(first.kind === 'rows' ? first.merges : undefined)
  // A function, so the check after an await is not narrowed away by the one in the loop's condition.
  const stopped = (): boolean => deps.stop?.aborted === true
  while (!stopped()) {
    // The endpoint is read each time: a daemon that restarted may listen on another port with another token.
    const now = readDaemonEndpoint(env.dataDir)
    const answer: Poll = now === null ? { kind: 'down' } : await poll(env, source, now.port, now.token, args, cursor, deps.stop)
    if (stopped()) break
    if (answer.kind === 'rows') {
      if (waiting) say('the daemon is back')
      waiting = false
      showUpdate(answer.update)
      showMerges(answer.merges)
      if (answer.epoch !== undefined && epoch !== undefined && answer.epoch !== epoch) {
        // A restarted daemon's trace counts from 0 again: read it from its start, and drop this answer, which was cut by the old cursor.
        epoch = answer.epoch
        cursor = 0
      } else {
        for (const line of answer.lines) env.out(line)
        cursor = Math.max(cursor, answer.cursor)
      }
    } else if (!waiting) {
      waiting = true
      say('the daemon is not answering; waiting for it')
    }
    await pause(env, deps.pollMs ?? WATCH_POLL_MS, deps.stop)
  }
  return EXIT_OK
}
