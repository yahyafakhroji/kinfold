import { afterEach, beforeEach, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type RunningDaemon, startDaemon } from '../daemon/daemon'
import { SQLITE3MC_LIB_ENV } from '../sqlite/library'
import { listRecentSessions } from '../store/reads'
import { openStore } from '../store/db'
import { CONTEXT_BUDGET_MS, fetchContext } from '../context/client'
import { rebuildProjectPacks } from '../context/packs'
import { seedObservation } from '../context/test-support'
import { upsertProject, upsertSession } from '../store/writes'
import { runHook as runHookInProcess } from './hook'
import { NUDGE_BUDGET_MS } from './record'

const HOOK = join(import.meta.dir, 'hook.ts')
const FIXTURES = join(import.meta.dir, '../../test/fixtures/claude-code')

let root: string
let dataDir: string
let daemon: RunningDaemon | null

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'sam-hook-'))
  dataDir = join(root, 'data')
  daemon = null
})
afterEach(async () => {
  if (daemon !== null) await daemon.stop()
  rmSync(root, { recursive: true, force: true })
})

interface HookRun {
  exitCode: number
  stdout: string
  stderr: string
}

async function runHook(stdin: string, extraEnv: Record<string, string> = {}): Promise<HookRun> {
  const child = Bun.spawn([process.execPath, HOOK], {
    stdin: new TextEncoder().encode(stdin),
    stdout: 'pipe',
    stderr: 'pipe',
    env: { PATH: process.env.PATH ?? '', HOME: root, KINFOLD_DATA_DIR: dataDir, [SQLITE3MC_LIB_ENV]: process.env[SQLITE3MC_LIB_ENV] ?? '', KINFOLD_DB_KEYSTORE: 'none', ...extraEnv },
  })
  const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  return { exitCode, stdout, stderr }
}

const fixture = (name: string): string => readFileSync(join(FIXTURES, name), 'utf8')
const spooled = (): string[] => {
  const dir = join(dataDir, 'spool')
  return existsSync(dir) ? readdirSync(dir).filter((name) => name.endsWith('.json')) : []
}

test.each([['not json at all'], [''], ['{"hook_event_name":"PostToolUse"}'], ['[1,2,3]']])(
  'malformed stdin %p prints nothing to stdout and exits 0',
  async (stdin) => {
    const run = await runHook(stdin)
    expect(run).toMatchObject({ exitCode: 0, stdout: '' })
    expect(run.stderr).toStartWith('kinfold-hook:')
    expect(spooled()).toEqual([])
  },
)

test('a hook event P0 does not capture is ignored silently', async () => {
  expect(await runHook(fixture('subagent-stop.json'))).toEqual({ exitCode: 0, stdout: '', stderr: '' })
})

test('with the daemon down the event is spooled, stdout stays empty and the exit is 0', async () => {
  const run = await runHook(fixture('post-tool-use.bash.json'))
  expect(run).toMatchObject({ exitCode: 0, stdout: '' })
  expect(run.stderr).toContain('nudge skipped')
  expect(spooled()).toHaveLength(1)
})

test('a stale daemon.json pointing at a closed port still exits 0 within the budget', async () => {
  mkdirSync(dataDir, { recursive: true })
  writeFileSync(join(dataDir, 'daemon.json'), JSON.stringify({ pid: 1, port: 1 }))
  writeFileSync(join(dataDir, 'daemon.token'), 'a'.repeat(64))
  const run = await runHook(fixture('post-tool-use.bash.json'))
  expect(run).toMatchObject({ exitCode: 0, stdout: '' })
  expect(run.stderr).toContain('daemon unreachable')
  expect(spooled()).toHaveLength(1)
})

test('with the daemon up the nudge lands the event in the store', async () => {
  daemon = startDaemon({ dataDir, port: 0, fallbackDrainMs: 60_000, log: () => {} })
  const run = await runHook(fixture('post-tool-use.bash.json'))
  expect(run).toEqual({ exitCode: 0, stdout: '', stderr: '' })
  await daemon.scheduler.whenIdle()

  const reader = openStore(dataDir)
  try {
    const sessions = listRecentSessions(reader.db, null)
    expect(sessions).toEqual([expect.objectContaining({ host: 'claude-code', hostSessionId: '00000000-0000-4000-8000-000000000001', eventCount: 1 })])
  } finally {
    reader.db.close()
  }
  expect(spooled()).toEqual([])
})

test('under the observer (KINFOLD_OBSERVER=1) the hook captures nothing, even with the daemon up', async () => {
  daemon = startDaemon({ dataDir, port: 0, fallbackDrainMs: 60_000, log: () => {} })
  const run = await runHook(fixture('post-tool-use.bash.json'), { KINFOLD_OBSERVER: '1' })
  expect(run).toEqual({ exitCode: 0, stdout: '', stderr: '' })
  await daemon.scheduler.whenIdle()
  expect(spooled()).toEqual([])
  const reader = openStore(dataDir)
  try {
    expect(listRecentSessions(reader.db, null)).toEqual([])
  } finally {
    reader.db.close()
  }
})

test('runHook itself returns early under the observer env', async () => {
  const errors: string[] = []
  await runHookInProcess(fixture('post-tool-use.bash.json'), dataDir, (line) => errors.push(line), { KINFOLD_OBSERVER: '1' })
  expect(errors).toEqual([])
  expect(existsSync(join(dataDir, 'spool'))).toBe(false)
})

// --- SessionStart context injection (task 8) ---

const PROJECT_NAME = 'hook-repo'

/** The temp root is the project (not a git checkout, so keyed by path); one observation and fresh packs. */
function seedProjectPack(title: string): void {
  const store = openStore(dataDir)
  try {
    upsertProject(store.db, { key: root, kind: 'path', displayName: PROJECT_NAME }, Date.now())
    const session = upsertSession(store.db, { host: 'opencode', hostSessionId: 'oc-seed', projectKey: root, cwd: root, occurredAt: Date.now() })
    seedObservation(store, { sessionId: session, projectKey: root, host: 'opencode', title, at: Date.now() })
    rebuildProjectPacks(store.db, root, Date.now())
  } finally {
    store.db.close()
  }
}

const inRoot = (name: string): string => JSON.stringify({ ...JSON.parse(fixture(name)), cwd: root })

test('SessionStart prints exactly one SessionStart JSON object carrying the pack, and the injection is recorded', async () => {
  seedProjectPack('Hook injects the shared pack')
  daemon = startDaemon({ dataDir, port: 0, fallbackDrainMs: 60_000, log: () => {} })
  const run = await runHook(inRoot('session-start.json'))
  expect(run.exitCode).toBe(0)
  expect(run.stdout.trim().split('\n')).toHaveLength(1)
  const output = JSON.parse(run.stdout) as { hookSpecificOutput: { hookEventName: string; additionalContext: string } }
  expect(Object.keys(output)).toEqual(['hookSpecificOutput'])
  expect(output.hookSpecificOutput.hookEventName).toBe('SessionStart')
  expect(output.hookSpecificOutput.additionalContext).toStartWith('<kinfold>')
  expect(output.hookSpecificOutput.additionalContext).toContain('[opencode · 1m · tool-verified] Hook injects the shared pack (#1)')

  const reader = openStore(dataDir)
  try {
    expect(reader.db.query('SELECT host, host_session_id, channel FROM injections').all()).toEqual([
      { host: 'claude-code', host_session_id: '00000000-0000-4000-8000-000000000001', channel: 'session_start' },
    ])
  } finally {
    reader.db.close()
  }
})

test('every other event leaves stdout empty, even with a pack waiting', async () => {
  seedProjectPack('A pack nobody should print')
  daemon = startDaemon({ dataDir, port: 0, fallbackDrainMs: 60_000, log: () => {} })
  for (const name of ['user-prompt-submit.json', 'post-tool-use.bash.json', 'stop.json', 'session-end.json']) {
    expect(await runHook(inRoot(name))).toMatchObject({ exitCode: 0, stdout: '' })
  }
})

test('SessionStart with an empty pack prints nothing', async () => {
  daemon = startDaemon({ dataDir, port: 0, fallbackDrainMs: 60_000, log: () => {} })
  expect(await runHook(inRoot('session-start.json'))).toMatchObject({ exitCode: 0, stdout: '' })
})

test('with the daemon down, SessionStart prints the stored pack from the read-only fallback', async () => {
  seedProjectPack('Stored pack survives a dead daemon')
  const run = await runHook(inRoot('session-start.json'))
  expect(run.exitCode).toBe(0)
  const output = JSON.parse(run.stdout) as { hookSpecificOutput: { additionalContext: string } }
  expect(output.hookSpecificOutput.additionalContext).toContain('Stored pack survives a dead daemon')
  expect(run.stderr).toContain('injection not recorded (read-only path)')
})

test('a daemon that never answers costs at most the 300 ms budget, prints nothing and exits 0', async () => {
  const hung = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Promise<Response>(() => {}) })
  try {
    mkdirSync(dataDir, { recursive: true })
    writeFileSync(join(dataDir, 'daemon.json'), JSON.stringify({ pid: 1, port: hung.port }))
    writeFileSync(join(dataDir, 'daemon.token'), 'a'.repeat(64))
    const fetched = await fetchContext(dataDir, { host: 'claude-code', cwd: root, hostSessionId: 's', channel: 'session_start' })
    expect(fetched).toMatchObject({ source: 'none', result: null })
    expect(fetched.ms).toBeLessThan(CONTEXT_BUDGET_MS + 60)

    const startedAt = performance.now()
    const run = await runHook(inRoot('session-start.json'))
    expect(run).toMatchObject({ exitCode: 0, stdout: '' })
    // Process start, the 250 ms capture nudge, then the 300 ms context budget.
    expect(performance.now() - startedAt).toBeLessThan(NUDGE_BUDGET_MS + CONTEXT_BUDGET_MS + 700)
  } finally {
    hung.stop(true)
  }
})

test('runHook returns null for SessionStart under the observer, and the output line otherwise', async () => {
  seedProjectPack('In-process pack')
  daemon = startDaemon({ dataDir, port: 0, fallbackDrainMs: 60_000, log: () => {} })
  expect(await runHookInProcess(inRoot('session-start.json'), dataDir, () => {}, { KINFOLD_OBSERVER: '1' })).toBeNull()
  const line = await runHookInProcess(inRoot('session-start.json'), dataDir, () => {}, {})
  expect(JSON.parse(line!).hookSpecificOutput.additionalContext).toContain('In-process pack')
})
