// The dashboard's large-data budget: an encrypted store of 30,000 memories
// and 3,000 sessions (with their prompts, recall rows, summary runs and
// activity), the real daemon on a free port, and every API call the new
// dashboard's pages make, each asked several times as a page and its
// background refreshes would. Each call's p95, measured by the client, must
// stay under P95_CEILING_MS. It prints the p95 of each so runs can be compared.

import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type DbKeyStore, newDbKey } from '../sqlite/keys'
import { recordActivity } from '../store/activity-store'
import { recordInjection } from '../store/context-store'
import { TOKEN_FILE } from '../store/data-dir'
import { openStore } from '../store/db'
import { insertObservation } from '../store/observer-store'
import { insertPrompt, upsertProject, upsertSession } from '../store/writes'
import { benchWords } from '../../test/recall-bench-words'
import { type RunningDaemon, startDaemon } from './daemon'

const MEMORIES = 30_000
const SESSIONS = 3_000
const PROJECTS = 40
const PROMPTS_PER_SESSION = 12
const ACTIVITY = 50_000
const ASKS = 12
/** The design's budget, for a developer machine. */
export const P95_BUDGET_MS = 300
/** Shared CI runners run several jobs per host and are two to three times slower than a laptop here; they get twice the budget. */
export const P95_CEILING_MS = process.env.CI === 'true' ? 2 * P95_BUDGET_MS : P95_BUDGET_MS
const HOSTS = ['claude-code', 'codex', 'opencode', 'cursor'] as const

let root: string
let dataDir: string
let daemon: RunningDaemon
let token: string
const KEY = newDbKey()
const keys: DbKeyStore = { name: 'bench', read: () => KEY, exists: () => true }
const { sentence } = benchWords(11)

function seedStore(): void {
  const store = openStore(dataDir, { keys })
  const now = Date.now()
  const db = store.db
  try {
    db.transaction(() => {
      const projects = Array.from({ length: PROJECTS }, (_, index) => {
        const key = `github.com/bench/project-${index}`
        upsertProject(db, { key, kind: 'git-remote', displayName: `project-${index}` }, now)
        return key
      })
      const sessions = Array.from({ length: SESSIONS }, (_, index) => {
        const host = HOSTS[index % HOSTS.length]!
        const at = now - (SESSIONS - index) * 600_000
        const id = upsertSession(db, { host, hostSessionId: `s-${index}`, projectKey: projects[index % PROJECTS]!, cwd: `/w/${index % PROJECTS}`, occurredAt: at, device: index % 3 === 0 ? 'dev-bench' : 'local' })
        for (let n = 1; n <= PROMPTS_PER_SESSION; n += 1) insertPrompt(db, { sessionId: id, promptNumber: n, text: sentence(30), occurredAt: at + n * 1_000 })
        db.query(`INSERT INTO observer_runs (session_id, host, provider, model, status, event_count, started_at, finished_at, input_tokens, output_tokens)
          VALUES ($id, $host, 'claude-cli', 'm', 'succeeded', 10, $at, $at, 4000, 600)`).run({ id, host, at })
        return { id, host, at, projectKey: projects[index % PROJECTS]! }
      })
      for (let index = 0; index < MEMORIES; index += 1) {
        const session = sessions[index % SESSIONS]!
        insertObservation(db, {
          projectKey: session.projectKey, sessionId: session.id, host: session.host, promptNumber: 1 + (index % PROMPTS_PER_SESSION), type: index % 4 === 0 ? 'decision' : 'discovery',
          title: sentence(8), narrative: sentence(60), facts: JSON.stringify([sentence(10), sentence(10)]), files: '[]', evidence: 'tool-verified', sourceEventIds: '[]',
          observerModel: 'bench', contentHash: `bench-${index}`, occurredAt: session.at, createdAt: session.at, observerRunId: (index % SESSIONS) + 1,
        })
      }
      for (const [index, session] of sessions.entries()) {
        for (let n = 1; n <= PROMPTS_PER_SESSION; n += 2) {
          recordInjection(db, { sessionId: session.id, host: session.host, hostSessionId: `s-${index}`, projectKey: session.projectKey,
            observationIds: [1 + ((index * 7 + n) % MEMORIES), 1 + ((index * 13 + n) % MEMORIES)], channel: 'prompt', tokens: 150, occurredAt: session.at + n * 1_000, promptNumber: n })
        }
      }
      for (let index = 0; index < ACTIVITY; index += 1) recordActivity(db, { kind: index % 2 === 0 ? 'save' : 'recall', at: now - index * 60_000, host: 'codex', count: 2 })
    })()
  } finally {
    db.close()
  }
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'sam-dashboard-bench-'))
  dataDir = join(root, 'data')
  seedStore()
  daemon = startDaemon({ dataDir, port: 0, fallbackDrainMs: 60_000, log: () => {}, dbKeys: keys })
  token = readFileSync(join(dataDir, TOKEN_FILE), 'utf8').trim()
}, 120_000)
afterAll(async () => {
  await daemon?.stop()
  rmSync(root, { recursive: true, force: true })
})

const PATHS = [
  '/memory/overview', '/memory/impact?window=7d', '/memory/impact?window=30d',
  '/memory/list/sessions', '/memory/list/sessions?sort=prompts&dir=desc', '/memory/list/sessions?page=40', '/memory/list/sessions?q=project-3&device=dev-bench',
  '/memory/list/memories', '/memory/list/memories?sort=recalls&dir=desc', '/memory/list/memories?sort=title&dir=asc', '/memory/list/memories?page=500',
  '/memory/list/memories?q=bench', '/memory/list/memories?project=github.com/bench/project-5&type=decision',
  '/memory/list/activity', '/memory/list/activity?kind=save&page=200', '/memory/list/projects', '/memory/list/devices',
  '/memory/sessions/1500', '/memory/sessions/1500/turns', '/memory/observations/15000', '/memory/facets',
]

function p95(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)]!
}

test('every call the dashboard makes answers within its p95 budget on a large store', async () => {
  // The daemon measures its kept reports in the background after it starts (dashboard-views.ts warm),
  // so a page finds them ready; asked once here, as that warm-up would have.
  for (const path of ['/memory/overview', '/memory/impact?window=7d', '/memory/impact?window=30d']) {
    await (await fetch(`http://127.0.0.1:${daemon.port}${path}`, { headers: { authorization: `Bearer ${token}` } })).arrayBuffer()
  }
  const results: [string, number][] = []
  for (const path of PATHS) {
    const times: number[] = []
    for (let ask = 0; ask < ASKS; ask += 1) {
      const startedAt = performance.now()
      const response = await fetch(`http://127.0.0.1:${daemon.port}${path}`, { headers: { authorization: `Bearer ${token}` } })
      await response.arrayBuffer()
      times.push(performance.now() - startedAt)
      expect([path, response.status]).toEqual([path, 200])
    }
    results.push([path, Math.round(p95(times))])
  }
  process.stderr.write(`dashboard bench: memories=${MEMORIES} sessions=${SESSIONS} ceiling=${P95_CEILING_MS}ms\n${results.map(([path, ms]) => `  p95=${ms}ms ${path}`).join('\n')}\n`)
  for (const [path, ms] of results) expect([path, ms <= P95_CEILING_MS]).toEqual([path, true])
}, 300_000)
