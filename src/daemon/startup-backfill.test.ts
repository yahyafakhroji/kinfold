// The project-merge backfill runs git once per project folder that has no
// first commit on record. A slow git (a large repo, a cold disk) must never
// hold the thread that answers hooks: the daemon answers /health and
// /context while the backfill waits on git, and the backfill still lands.

import { afterEach, beforeEach, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { posixOnly } from '../../test/platform-guards'
import { seedObservation } from '../context/test-support'
import { TOKEN_FILE } from '../store/data-dir'
import { openStore } from '../store/db'
import { NO_DB_KEYS } from '../sqlite/keys'
import { openStoreFile } from '../sqlite/open'
import { upsertProject, upsertSession } from '../store/writes'
import { PROMPT_SERVE_BUDGET_MS } from './context-route'
import { type RunningDaemon, startDaemon } from './daemon'

const ROOT_COMMIT = 'a'.repeat(40)
/** Far past the hook's wait: a backfill on the answering thread would hold every request this long. */
const SLOW_GIT_MS = 2_000

let root: string
let daemon: RunningDaemon | null = null
let savedPath: string | undefined

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'kinfold-backfill-'))
  savedPath = process.env.PATH
})
afterEach(async () => {
  await daemon?.stop()
  daemon = null
  process.env.PATH = savedPath
  rmSync(root, { recursive: true, force: true })
})

/** A git that is slow to name the first commit of folders called slow-*, and says "not a repo" for everything else at once. */
function fakeGit(): string {
  const bin = join(root, 'bin')
  mkdirSync(bin)
  const script = join(bin, 'git')
  writeFileSync(script, `#!/bin/sh
case "$2" in
  *slow-*) if [ "$3" = "rev-list" ]; then sleep ${SLOW_GIT_MS / 1000}; echo ${ROOT_COMMIT}; exit 0; fi ;;
esac
exit 1
`)
  chmodSync(script, 0o755)
  // A new executable's first run can be slow while the OS checks it; that cost is the test's, not the daemon's.
  Bun.spawnSync([script, '-C', root, 'status'])
  return bin
}

posixOnly('sh scripts')('the daemon answers /health and /context while the merge backfill waits on git', async () => {
  const dataDir = join(root, 'data')
  const here = join(root, 'here')
  const slowRepos = [join(root, 'slow-one'), join(root, 'slow-two')]
  for (const folder of [here, ...slowRepos]) mkdirSync(folder)
  const store = openStore(dataDir)
  upsertProject(store.db, { key: here, kind: 'path', displayName: 'here' }, 1)
  const other = upsertSession(store.db, { host: 'opencode', hostSessionId: 'old', projectKey: here, cwd: here, occurredAt: 1 })
  seedObservation(store, { sessionId: other, projectKey: here, host: 'opencode', title: 'CSV parser drops quotes on export', at: 1 })
  slowRepos.forEach((folder, index) => {
    const key = `github.com/acme/slow-${index}`
    upsertProject(store.db, { key, kind: 'git-remote', displayName: `slow-${index}` }, 1)
    upsertSession(store.db, { host: 'opencode', hostSessionId: `slow-${index}`, projectKey: key, cwd: folder, occurredAt: 1 })
  })
  store.db.close()
  process.env.PATH = `${fakeGit()}:${savedPath ?? ''}`

  daemon = startDaemon({ dataDir, port: 0, log: () => {} })
  const token = readFileSync(join(dataDir, TOKEN_FILE), 'utf8').trim()
  const ask = async (path: string, body?: unknown): Promise<{ ms: number; body: unknown }> => {
    const startedAt = performance.now()
    const response = await fetch(`http://127.0.0.1:${daemon!.port}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    return { body: await response.json(), ms: performance.now() - startedAt }
  }
  // Asked at once, as a hook right after a restart would: the clocks start before the backfill's first turn.
  const [health, context] = await Promise.all([
    ask('/health'),
    ask('/context', { host: 'claude-code', hostSessionId: 'now', cwd: here, channel: 'prompt', prompt: 'why does the csv parser drop quotes?' }),
  ])
  expect(health.ms).toBeLessThan(PROMPT_SERVE_BUDGET_MS)
  expect(context.ms).toBeLessThan(PROMPT_SERVE_BUDGET_MS)

  // The backfill still lands: both folders get their first commit, and being one repo, their projects merge.
  const deadline = Date.now() + SLOW_GIT_MS * 4
  let rooted: { key: string; merged: string | null }[] = []
  while (Date.now() < deadline) {
    const reader = openStoreFile(join(dataDir, 'memory.db'), { readonly: true, keys: NO_DB_KEYS })
    rooted = reader.query<{ key: string; merged: string | null }, []>('SELECT key, merged_into AS merged FROM projects WHERE root_commit IS NOT NULL ORDER BY key').all()
    reader.close()
    if (rooted.length === 2 && rooted.some((row) => row.merged !== null)) break
    await Bun.sleep(100)
  }
  expect(rooted.map((row) => row.key)).toEqual(['github.com/acme/slow-0', 'github.com/acme/slow-1'])
  expect(rooted.filter((row) => row.merged !== null)).toHaveLength(1)
}, 20_000)
