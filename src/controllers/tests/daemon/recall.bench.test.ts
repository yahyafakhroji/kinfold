// The prompt-time benchmark the hub's live watch asked for: a store of 30,000
// memories, the real daemon on a free port, and the load that held its thread
// there: an observer that fails and retries, and, from a process of its own
// as hooks and the dashboard are (test/recall-bench-load.ts), captures
// arriving and the dashboard reading data size, metrics and facets. Long pasted
// prompts ask for recall one after another, and the p95 of the answer time,
// measured by the client as a hook would, must fit the hook's wait. It prints
// p50, p95 and max so the numbers can be compared across changes.

import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PROMPT_SERVE_BUDGET_MS } from '../../daemon/context-route'
import { type RunningDaemon, startDaemon } from '../../daemon/daemon'
import { openStore } from '../../../resources/store/db'
import { TOKEN_FILE } from '../../../resources/store/data-dir'
import { insertObservation } from '../../../resources/store/observer-store'
import { insertEvent, upsertProject, upsertSession } from '../../../resources/store/writes'
import { type DbKeyStore, newDbKey } from '../../../resources/sqlite/keys'
import { recordInjection } from '../../../resources/store/context-store'
import { benchWords } from '../../../../test/recall-bench-words'

const MEMORIES = 30_000
const SESSIONS = 200
const PROMPTS = 30
/** A hub's store holds far more captured events and recall rows than memories; the dashboard reads them. */
const EVENTS = 150_000
const INJECTIONS = 20_000
/** The answer must reach the hook before it gives up: what the hook waits, less its own share. */
const P95_CEILING_MS = PROMPT_SERVE_BUDGET_MS
/** Answers that must carry memory: each prompt has new memory from other sessions waiting, at least. */
const MIN_CARRIED_SHARE = 0.8
/**
 * Answers in time that must carry related memory as well: every prompt here
 * shares rare words with many stored memories, so an on-time answer without
 * any means the related search missed the deadline, the failure the hub saw.
 */
const MIN_RELATED_SHARE = 0.95
/** The delta's own read, beside the keyword read: index reads of a few rows. */
const DELTA_P95_CEILING_MS = 20
/** How often `kinfold watch --debug` asks, as the user's watcher did during the hub's misses: its trace reads run beside the prompts. */
const WATCH_POLL_MS = 1_000
/** A request the old daemon never answered is counted at this, so the run ends. */
const CLIENT_GIVE_UP_MS = 15_000
const BENCH_SESSION = 'bench-session'
const HOST = 'claude-code'

let root: string
let dataDir: string
let daemon: RunningDaemon
let token: string
let load: ReturnType<typeof Bun.spawn> & { stdout: ReadableStream<Uint8Array> } | null = null
const LOAD_SCRIPT = join(import.meta.dir, '../../../../test/recall-bench-load.ts')
// Encrypted, as the hub's store is: every page read is also decrypted.
const KEY = newDbKey()
const keys: DbKeyStore = { name: 'bench', read: () => KEY, exists: () => true }
/** The daemon's log, printed for the slow answers when the run fails: counts and timings only. */
const daemonLog: string[] = []

const { word, sentence } = benchWords(7)

function seedStore(): void {
  const store = openStore(dataDir, { keys })
  const now = Date.now()
  try {
    store.db.transaction(() => {
      upsertProject(store.db, { key: root, kind: 'path', displayName: 'bench' }, now)
      const sessions = Array.from({ length: SESSIONS }, (_, index) =>
        upsertSession(store.db, { host: index % 2 === 0 ? 'opencode' : HOST, hostSessionId: `seed-${index}`, projectKey: root, cwd: root, occurredAt: now - 90 * 86_400_000 }))
      for (let index = 0; index < MEMORIES; index += 1) {
        // The newest 40 arrive after the bench session started: its delta has something to offer.
        const at = index >= MEMORIES - 40 ? now + 1_000 : now - (MEMORIES - index) * 60_000
        insertObservation(store.db, {
          projectKey: root, sessionId: sessions[index % SESSIONS]!, host: index % 2 === 0 ? 'opencode' : HOST, promptNumber: 1, type: 'discovery',
          title: sentence(8), narrative: sentence(60), facts: JSON.stringify([sentence(10), sentence(10), sentence(10)]), files: '[]',
          evidence: 'tool-verified', sourceEventIds: '[]', observerModel: 'bench', contentHash: `bench-${index}`, occurredAt: at, createdAt: at,
        })
      }
      for (let index = 0; index < EVENTS; index += 1) {
        const at = now - (EVENTS - index) * 4_000
        insertEvent(store.db, {
          eventId: `bench-event-${index}`, sessionId: sessions[index % SESSIONS]!, promptNumber: null, kind: 'tool_result', toolName: 'Bash',
          payload: JSON.stringify({ tool: { name: 'Bash', output: sentence(150) } }), withheld: null, redactions: '[]', contentHash: `e-${index}`, occurredAt: at, ingestedAt: at,
        })
      }
      for (let index = 0; index < INJECTIONS; index += 1) {
        const at = now - (INJECTIONS - index) * 30_000
        recordInjection(store.db, { sessionId: sessions[index % SESSIONS]!, host: HOST, hostSessionId: `seed-${index % SESSIONS}`, projectKey: root,
          observationIds: [index + 1, index + 2, index + 3], channel: index % 5 === 0 ? 'session_start' : 'prompt', tokens: 120, occurredAt: at, durationMs: 40 })
      }
      // Observed long ago, as on a hub: only what arrives during the run is pending for the observer.
      store.db.run("UPDATE events SET observer_state = 'done'")
      const own = upsertSession(store.db, { host: HOST, hostSessionId: BENCH_SESSION, projectKey: root, cwd: root, occurredAt: now })
      recordInjection(store.db, { sessionId: own, host: HOST, hostSessionId: BENCH_SESSION, projectKey: root, observationIds: [1], channel: 'session_start', tokens: 10, occurredAt: now })
    })()
  } finally {
    store.db.close()
  }
}

function longPrompt(index: number): string {
  const id = (0xbb24 + index).toString(16)
  return `why does the ${word()} ${word()} fail after the ${word()} change?\n<pasted_content id="${id}">\n${sentence(240)}\n</pasted_content id="${id}">`
}

async function call(method: string, path: string, body?: unknown): Promise<number> {
  const startedAt = performance.now()
  try {
    const response = await fetch(`http://127.0.0.1:${daemon.port}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(CLIENT_GIVE_UP_MS),
    })
    await response.arrayBuffer()
  } catch {
    // Timed out: counted at the give-up time below.
  }
  return Math.min(performance.now() - startedAt, CLIENT_GIVE_UP_MS)
}

/** The captures and dashboard reads, in a process of their own (test/recall-bench-load.ts); ready once it says so. */
async function startLoad(): Promise<void> {
  load = Bun.spawn([process.execPath, LOAD_SCRIPT, dataDir, String(daemon.port), token, root], { stdout: 'pipe', stderr: 'inherit' })
  const reader = load.stdout.getReader()
  await reader.read()
  reader.releaseLock()
}

/** One prompt as the hook asks it: how long the answer took, and whether it carried any memory. */
async function ask(prompt: string): Promise<{ ms: number; ids: number }> {
  const startedAt = performance.now()
  try {
    const response = await fetch(`http://127.0.0.1:${daemon.port}/context`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ host: HOST, hostSessionId: BENCH_SESSION, cwd: root, channel: 'prompt', prompt }),
      signal: AbortSignal.timeout(CLIENT_GIVE_UP_MS),
    })
    const body = await response.json() as { observationIds?: number[] }
    return { ms: performance.now() - startedAt, ids: body.observationIds?.length ?? 0 }
  } catch {
    return { ms: CLIENT_GIVE_UP_MS, ids: 0 }
  }
}

const percentile = (sorted: readonly number[], p: number): number => sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)]!

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'kinfold-recall-bench-'))
  dataDir = join(root, 'data')
  seedStore()
  daemon = startDaemon({
    dataDir, port: 0, fallbackDrainMs: 200, log: (line) => daemonLog.push(line), dbKeys: keys,
    // An observer whose every run fails, started by every capture: it competes for the daemon as the hub's did.
    observer: { runnerFor: () => ({ run: async () => { throw new Error('observer unavailable') } }), schedule: { quietMs: 0, batchAtEvents: 1, maxWaitMs: 0 } },
  })
  token = readFileSync(join(dataDir, TOKEN_FILE), 'utf8').trim()
}, 120_000)

afterAll(async () => {
  load?.kill()
  await load?.exited
  await daemon?.stop()
  rmSync(root, { recursive: true, force: true })
}, 60_000)

test(`a long pasted prompt on a ${MEMORIES.toLocaleString('en')}-memory store under load is answered within the hook's wait at p95`, async () => {
  // Warm the store as a running hub's is: one answer before the load starts.
  await call('POST', '/context', { host: HOST, hostSessionId: BENCH_SESSION, cwd: root, channel: 'prompt', prompt: longPrompt(-1) })
  await startLoad()
  let watching = true
  const watcher = (async () => {
    while (watching) {
      await call('GET', '/watch/debug')
      await Bun.sleep(WATCH_POLL_MS)
    }
  })()
  await Bun.sleep(300)
  const samples: number[] = []
  let carried = 0
  let withRelated = 0
  let relatedHits = 0
  const deltaSamples: number[] = []
  for (let index = 0; index < PROMPTS; index += 1) {
    const before = daemonLog.length
    const answer = await ask(longPrompt(index))
    samples.push(answer.ms)
    if (answer.ids > 0) carried += 1
    const line = daemonLog.slice(before).find((entry) => entry.startsWith('context ') && entry.includes('channel=prompt'))
    const related = Number(/ related=(\d+)/.exec(line ?? '')?.[1] ?? 0)
    if (related > 0 && answer.ms <= P95_CEILING_MS) withRelated += 1
    relatedHits += related
    deltaSamples.push(Number(/ delta_ms=(\d+)/.exec(line ?? '')?.[1] ?? CLIENT_GIVE_UP_MS))
    await Bun.sleep(100)
  }
  watching = false
  await watcher
  const sorted = [...samples].sort((a, b) => a - b)
  const p95 = percentile(sorted, 0.95)
  const deltaP95 = percentile([...deltaSamples].sort((a, b) => a - b), 0.95)
  process.stderr.write(`recall bench: memories=${MEMORIES} prompts=${PROMPTS} p50=${percentile(sorted, 0.5).toFixed(0)}ms p95=${p95.toFixed(0)}ms max=${sorted.at(-1)!.toFixed(0)}ms carried=${carried}/${PROMPTS} related_in_time=${withRelated}/${PROMPTS} related_hits=${relatedHits} delta_p95=${deltaP95}ms\n`)
  if (p95 > P95_CEILING_MS || carried / PROMPTS < MIN_CARRIED_SHARE || withRelated / PROMPTS < MIN_RELATED_SHARE) {
    const slow = daemonLog.filter((line) => line.startsWith('context ') && Number(/ ms=(\d+)/.exec(line)?.[1] ?? 0) > 100)
    process.stderr.write(`recall bench samples: ${samples.map((ms) => ms.toFixed(0)).join(' ')}\n${slow.slice(-12).join('\n')}\n`)
  }
  process.stderr.write(daemonLog.filter((l) => l.startsWith("context ")).join("\n") + "\n")
  // The load ran: its captures reached the daemon while the prompts were asked.
  expect(daemonLog.some((line) => /^drained read=\d+ inserted=[1-9]/.test(line))).toBe(true)
  expect(p95).toBeLessThanOrEqual(P95_CEILING_MS)
  // An answer in time that never carries memory would pass the clock and fail the user.
  expect(carried / PROMPTS).toBeGreaterThanOrEqual(MIN_CARRIED_SHARE)
  // The delta alone fills the count above; related memory in time is what the hub's answers lacked.
  expect(withRelated / PROMPTS).toBeGreaterThanOrEqual(MIN_RELATED_SHARE)
  expect(deltaP95).toBeLessThanOrEqual(DELTA_P95_CEILING_MS)
}, 900_000)
