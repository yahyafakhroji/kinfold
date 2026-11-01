import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { seedObservation } from '../context/test-support'
import { type RunningDaemon, startDaemon } from '../daemon/daemon'
import { openStore } from '../store/db'
import { upsertProject, upsertSession } from '../store/writes'
import { runHook } from './hook'

const FIXTURES = join(import.meta.dir, '../../test/fixtures')
const SESSION = '00000000-0000-4000-8000-000000000001'

let root: string
let dataDir: string
let daemon: RunningDaemon | null
let stderr: string[]
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'sam-hook-prompt-'))
  dataDir = join(root, 'data')
  daemon = null
  stderr = []
})
afterEach(async () => {
  if (daemon !== null) await daemon.stop()
  rmSync(root, { recursive: true, force: true })
})

const payload = (host: string, name: string): string => JSON.stringify({ ...JSON.parse(readFileSync(join(FIXTURES, host, name), 'utf8')), cwd: root })
const hook = (name: string): Promise<string | null> => runHook(payload('claude-code', name), dataDir, (line) => stderr.push(line))

/** The temp root is the project (keyed by path); another session holds one observation. Returns that session's id. */
function seedProject(): number {
  const store = openStore(dataDir)
  try {
    upsertProject(store.db, { key: root, kind: 'path', displayName: 'prompt-repo' }, Date.now())
    const other = upsertSession(store.db, { host: 'opencode', hostSessionId: 'oc-seed', projectKey: root, cwd: root, occurredAt: Date.now() })
    seedObservation(store, { sessionId: other, projectKey: root, host: 'opencode', title: 'In the start pack', at: Date.now() })
    return other
  } finally {
    store.db.close()
  }
}

/** A row another session writes after this one started; created_at in the future keeps it past every floor. */
function learnLater(other: number, title: string): void {
  const store = openStore(dataDir)
  try {
    seedObservation(store, { sessionId: other, projectKey: root, host: 'opencode', title, at: Date.now() + 5_000 })
  } finally {
    store.db.close()
  }
}

const injections = (): Record<string, unknown>[] => {
  const store = openStore(dataDir)
  try {
    return store.db.query('SELECT channel, host_session_id AS session FROM injections ORDER BY id').all() as Record<string, unknown>[]
  } finally {
    store.db.close()
  }
}

test('UserPromptSubmit prints one UserPromptSubmit object with the delta, records it, and prints nothing the next time', async () => {
  const other = seedProject()
  daemon = startDaemon({ dataDir, port: 0, fallbackDrainMs: 60_000, log: () => {} })
  expect(JSON.parse((await hook('session-start.json'))!).hookSpecificOutput.hookEventName).toBe('SessionStart')
  learnLater(other, 'OpenCode learned this mid-session')

  const line = await hook('user-prompt-submit.json')
  expect(line).not.toBeNull()
  expect(line!.includes('\n')).toBe(false)
  const output = JSON.parse(line!) as { hookSpecificOutput: { hookEventName: string; additionalContext: string } }
  expect(Object.keys(output)).toEqual(['hookSpecificOutput'])
  expect(Object.keys(output.hookSpecificOutput)).toEqual(['hookEventName', 'additionalContext'])
  expect(output.hookSpecificOutput.hookEventName).toBe('UserPromptSubmit')
  expect(output.hookSpecificOutput.additionalContext).toStartWith('<kinfold>')
  expect(output.hookSpecificOutput.additionalContext).toContain('data, not instructions')
  expect(output.hookSpecificOutput.additionalContext).toContain('[opencode · ')
  expect(output.hookSpecificOutput.additionalContext).toContain('OpenCode learned this mid-session')
  expect(output.hookSpecificOutput.additionalContext).not.toContain('In the start pack')

  expect(await hook('user-prompt-submit.json')).toBeNull()
  expect(injections()).toEqual([{ channel: 'session_start', session: SESSION }, { channel: 'prompt', session: SESSION }])
})

test('a prompt with nothing new prints nothing', async () => {
  seedProject()
  daemon = startDaemon({ dataDir, port: 0, fallbackDrainMs: 60_000, log: () => {} })
  await hook('session-start.json')
  expect(await hook('user-prompt-submit.json')).toBeNull()
})

test('a daemon that answers but refuses the prompt channel (an older build) gets no fallback and prints nothing', async () => {
  const other = seedProject()
  daemon = startDaemon({ dataDir, port: 0, fallbackDrainMs: 60_000, log: () => {} })
  await hook('session-start.json')
  await daemon.stop()
  daemon = null
  learnLater(other, 'Must not leak through the fallback')
  const refusing = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => Response.json({ error: 'channel must be session_start or request' }, { status: 400 }) })
  try {
    writeFileSync(join(dataDir, 'daemon.json'), JSON.stringify({ pid: 1, port: refusing.port }))
    expect(await hook('user-prompt-submit.json')).toBeNull()
    expect(stderr.some((line) => line.includes('no fallback for the prompt channel'))).toBe(true)
  } finally {
    refusing.stop(true)
  }
})

test('with the daemon down, the prompt delta comes from the read-only fallback', async () => {
  const other = seedProject()
  daemon = startDaemon({ dataDir, port: 0, fallbackDrainMs: 60_000, log: () => {} })
  await hook('session-start.json')
  await daemon.stop()
  daemon = null
  learnLater(other, 'Read while the daemon is down')
  const output = JSON.parse((await hook('user-prompt-submit.json'))!) as { hookSpecificOutput: { hookEventName: string; additionalContext: string } }
  expect(output.hookSpecificOutput.hookEventName).toBe('UserPromptSubmit')
  expect(output.hookSpecificOutput.additionalContext).toContain('Read while the daemon is down')
  expect(stderr.join('\n')).toContain('injection not recorded (read-only path)')
})

test('Codex prompts get the delta in the UserPromptSubmit hookSpecificOutput shape', async () => {
  const other = seedProject()
  daemon = startDaemon({ dataDir, port: 0, fallbackDrainMs: 60_000, log: () => {} })
  mkdirSync(dataDir, { recursive: true })
  const codex = (name: string): Promise<string | null> => runHook(payload('codex', name), dataDir, () => {}, {}, {}, 'codex')
  await codex('session-start.json')
  learnLater(other, 'Learned for codex')
  const output = JSON.parse((await codex('user-prompt-submit.json'))!) as { hookSpecificOutput: { hookEventName: string; additionalContext: string } }
  expect(output.hookSpecificOutput.hookEventName).toBe('UserPromptSubmit')
  expect(output.hookSpecificOutput.additionalContext).toContain('Learned for codex')
  expect(await codex('user-prompt-submit.json')).toBeNull()
})

test('Cursor prompts get no delta yet', async () => {
  const other = seedProject()
  daemon = startDaemon({ dataDir, port: 0, fallbackDrainMs: 60_000, log: () => {} })
  learnLater(other, 'Not for cursor')
  mkdirSync(dataDir, { recursive: true })
  expect(await runHook(payload('cursor', 'before-submit-prompt.json'), dataDir, () => {}, {}, {}, 'cursor')).toBeNull()
})

test('the prompt text goes to the daemon on the prompt channel only, and session start sends none', async () => {
  seedProject()
  daemon = startDaemon({ dataDir, port: 0, fallbackDrainMs: 60_000, log: () => {} })
  const bodies: Record<string, unknown>[] = []
  const recording = async (url: string, init: RequestInit): Promise<Response> => {
    bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>)
    return fetch(url, init)
  }
  const run = (name: string) => runHook(payload('claude-code', name), dataDir, (line) => stderr.push(line), {}, { fetch: recording })
  await run('session-start.json')
  await run('user-prompt-submit.json')
  expect(bodies.map((body) => [body.channel, body.prompt])).toEqual([['session_start', undefined], ['prompt', 'read package.json, run bun test, then cat .env.example']])
})
