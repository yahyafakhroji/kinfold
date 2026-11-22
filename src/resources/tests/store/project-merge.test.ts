import { afterEach, beforeEach, expect, test } from 'bun:test'
import { seedObservation } from '../context/test-support'
import { type TempStore, openTempStore } from '../observer/test-support'
import { recordInjection } from '../../store/context-store'
import { backfillRoots, canonicalKey, listProjects, mergeProjects, planRootMerges, recentMerges, registerProject, splitProject } from '../../store/project-merge'
import { upsertSession } from '../../store/writes'
import { join } from 'node:path'
import { openTestDatabase } from '../sqlite/test-support'
import { MIGRATIONS } from '../../store/schema'

const ROOT = 'a'.repeat(40)
const OTHER_ROOT = 'b'.repeat(40)
const T0 = 1_792_900_000_000

let temp: TempStore
beforeEach(() => {
  temp = openTempStore('kinfold-project-merge-')
})
afterEach(() => temp.cleanup())

const db = () => temp.store.db
const remote = (key: string, rootCommit: string | null = ROOT) => ({ key, kind: 'git-remote' as const, displayName: key.split('/').at(-1)!, ...(rootCommit === null ? {} : { rootCommit }) })

/** A project with one session and `memories` observations, last active at `at`. */
function seedProject(project: ReturnType<typeof remote> | { key: string; kind: 'path'; displayName: string }, memories: number, at: number, session = `s-${project.key}`): { sessionId: number; ids: number[] } {
  registerProject(db(), project, at)
  const sessionId = upsertSession(db(), { host: 'claude-code', hostSessionId: session, projectKey: canonicalKey(db(), project.key), cwd: `/work/${project.displayName}`, occurredAt: at })
  const ids = Array.from({ length: memories }, (_, index) => seedObservation(temp.store, { sessionId, projectKey: canonicalKey(db(), project.key), host: 'claude-code', title: `${project.displayName} note ${index}`, at }))
  return { sessionId, ids }
}

const observationKeys = (): Record<string, number> => Object.fromEntries(
  db().query<{ key: string; n: number }, []>('SELECT project_key AS key, count(*) AS n FROM observations GROUP BY project_key ORDER BY project_key').all().map((row) => [row.key, row.n]))

test('a renamed remote: the old key merges into the new one when the new one first appears, and the old key then names the new one', () => {
  seedProject(remote('github.com/me/shared-agent-memory'), 3, T0)
  const key = registerProject(db(), remote('github.com/me/kinfold'), T0 + 1_000)
  expect(key).toBe('github.com/me/kinfold')
  expect(observationKeys()).toEqual({ 'github.com/me/kinfold': 3 })
  expect(canonicalKey(db(), 'github.com/me/shared-agent-memory')).toBe('github.com/me/kinfold')
  // An old clone still on the old remote lands on the new key.
  expect(registerProject(db(), remote('github.com/me/shared-agent-memory'), T0 + 2_000)).toBe('github.com/me/kinfold')
  expect(recentMerges(db(), T0)).toEqual([{ from: 'shared-agent-memory', into: 'kinfold', fromKey: 'github.com/me/shared-agent-memory', intoKey: 'github.com/me/kinfold', reason: 'same-repo', at: T0 + 1_000 }])
})

test('a fork shares its first commit, so it merges too; the key seen last wins', () => {
  seedProject(remote('github.com/upstream/tool'), 2, T0)
  seedProject(remote('github.com/me/tool'), 1, T0 + 500)
  expect(observationKeys()).toEqual({ 'github.com/me/tool': 3 })
})

test('a repo with no remote merges into the remote-based key of the same repo, whichever came first', () => {
  seedProject(remote('github.com/me/kinfold'), 2, T0)
  expect(registerProject(db(), { key: '/Users/me/kinfold-copy', kind: 'git-root', displayName: 'kinfold-copy', rootCommit: ROOT }, T0 + 1)).toBe('github.com/me/kinfold')
})

test('different repos and folders with no git never merge on their own', () => {
  seedProject(remote('github.com/me/kinfold'), 2, T0)
  seedProject(remote('github.com/me/other', OTHER_ROOT), 1, T0)
  seedProject({ key: '/Users/me/rea', kind: 'path', displayName: 'rea' }, 1, T0)
  expect(observationKeys()).toEqual({ '/Users/me/rea': 1, 'github.com/me/kinfold': 2, 'github.com/me/other': 1 })
})

test('split undoes a merge exactly, and the split key is held out of automatic merging', () => {
  const old = seedProject(remote('github.com/me/shared-agent-memory'), 2, T0)
  recordInjection(db(), { sessionId: old.sessionId, host: 'claude-code', hostSessionId: 's-github.com/me/shared-agent-memory', projectKey: 'github.com/me/shared-agent-memory', observationIds: old.ids, channel: 'session_start', tokens: 5, occurredAt: T0 })
  const fresh = seedProject(remote('github.com/me/kinfold'), 1, T0 + 1_000)
  expect(observationKeys()).toEqual({ 'github.com/me/kinfold': 3 })
  const preview = splitProject(db(), 'github.com/me/shared-agent-memory', T0 + 2_000, { dryRun: true })
  expect(preview).toMatchObject({ ok: true, dryRun: true, counts: { observations: 2, sessions: 1, injections: 1 } })
  expect(observationKeys()).toEqual({ 'github.com/me/kinfold': 3 })
  expect(splitProject(db(), 'github.com/me/shared-agent-memory', T0 + 2_000, { dryRun: false })).toMatchObject({ ok: true, dryRun: false })
  expect(observationKeys()).toEqual({ 'github.com/me/kinfold': 1, 'github.com/me/shared-agent-memory': 2 })
  expect(db().query('SELECT project_key AS key FROM injections').all()).toEqual([{ key: 'github.com/me/shared-agent-memory' }])
  expect(db().query('SELECT project_key AS key FROM sessions WHERE id = ?').get(fresh.sessionId)).toEqual({ key: 'github.com/me/kinfold' })
  // Seen again, the split key stays its own project.
  expect(registerProject(db(), remote('github.com/me/shared-agent-memory'), T0 + 3_000)).toBe('github.com/me/shared-agent-memory')
  expect(splitProject(db(), 'github.com/me/kinfold', T0, { dryRun: false })).toMatchObject({ ok: false })
})

test('a manual merge counts first and moves only when asked, for folders git cannot match', () => {
  seedProject({ key: '/Users/me/rea', kind: 'path', displayName: 'rea' }, 2, T0)
  seedProject(remote('github.com/me/kinfold'), 1, T0)
  expect(mergeProjects(db(), '/Users/me/rea', 'github.com/me/kinfold', T0 + 1, { dryRun: true })).toMatchObject({ ok: true, dryRun: true, counts: { observations: 2, sessions: 1 } })
  expect(observationKeys()['/Users/me/rea']).toBe(2)
  expect(mergeProjects(db(), '/Users/me/rea', 'github.com/me/kinfold', T0 + 1, { dryRun: false })).toMatchObject({ ok: true, dryRun: false })
  expect(observationKeys()).toEqual({ 'github.com/me/kinfold': 3 })
  expect(mergeProjects(db(), 'github.com/me/kinfold', 'github.com/me/kinfold', T0, { dryRun: true })).toMatchObject({ ok: false })
  expect(mergeProjects(db(), '/nope', 'github.com/me/kinfold', T0, { dryRun: true })).toMatchObject({ ok: false })
})

test('the list shows each key with its counts and where a merged key went', () => {
  seedProject(remote('github.com/me/shared-agent-memory'), 2, T0)
  seedProject(remote('github.com/me/kinfold'), 1, T0 + 1_000)
  expect(listProjects(db()).map((row) => [row.key, row.memories, row.sessions, row.mergedInto])).toEqual([
    ['github.com/me/kinfold', 3, 2, null],
    ['github.com/me/shared-agent-memory', 0, 0, 'github.com/me/kinfold'],
  ])
})

test('on upgrade, keys without a first commit get one from a session folder, and the same repo merges once', () => {
  // As stored before root commits were kept.
  for (const [key, at] of [['github.com/me/shared-agent-memory', T0], ['github.com/me/kinfold', T0 + 1_000]] as const) {
    seedProject(remote(key, null), 1, at)
  }
  seedProject({ key: '/Users/me/rea', kind: 'path', displayName: 'rea' }, 1, T0)
  const asked: string[] = []
  const rootFor = (cwd: string): string | null => (asked.push(cwd), cwd.startsWith('/work/') ? ROOT : null)
  expect(planRootMerges(db(), rootFor)).toEqual([{ fromKey: 'github.com/me/shared-agent-memory', intoKey: 'github.com/me/kinfold', from: 'shared-agent-memory', into: 'kinfold' }])
  expect(observationKeys()['github.com/me/shared-agent-memory']).toBe(1)
  expect(backfillRoots(db(), rootFor, T0 + 5_000).map((merge) => merge.intoKey)).toEqual(['github.com/me/kinfold'])
  expect(observationKeys()).toEqual({ '/Users/me/rea': 1, 'github.com/me/kinfold': 2 })
  expect(asked).not.toContain('/work/rea')
  // Nothing left to ask about the next time.
  asked.length = 0
  expect(backfillRoots(db(), rootFor, T0 + 6_000)).toEqual([])
})

test('the install output\'s plan reads a store from before first commits were kept, without changing it', () => {
  const legacy = openTempStore('kinfold-project-merge-v15-')
  try {
    const db15 = openTestDatabase(join(legacy.root, 'v15.db'))
    for (const sql of MIGRATIONS.slice(0, 15)) db15.run(sql)
    db15.run("INSERT INTO projects (key, key_kind, display_name, created_at) VALUES ('github.com/me/shared-agent-memory', 'git-remote', 'shared-agent-memory', 1), ('github.com/me/kinfold', 'git-remote', 'kinfold', 2)")
    db15.run("INSERT INTO sessions (host, host_session_id, project_key, cwd, started_at, last_event_at) VALUES ('claude-code', 'a', 'github.com/me/shared-agent-memory', '/work/a', 1, 1), ('claude-code', 'b', 'github.com/me/kinfold', '/work/b', 2, 2)")
    expect(planRootMerges(db15, () => ROOT)).toEqual([{ fromKey: 'github.com/me/shared-agent-memory', intoKey: 'github.com/me/kinfold', from: 'shared-agent-memory', into: 'kinfold' }])
    db15.close()
  } finally {
    legacy.cleanup()
  }
})

test('split after a chain of merges still puts the rows back, with what the moved sessions wrote since', () => {
  const a = seedProject(remote('github.com/me/a'), 2, T0)
  seedProject(remote('github.com/me/b', OTHER_ROOT), 1, T0)
  mergeProjects(db(), 'github.com/me/a', 'github.com/me/b', T0 + 1, { dryRun: false })
  seedProject(remote('github.com/me/c', 'c'.repeat(40)), 1, T0)
  mergeProjects(db(), 'github.com/me/b', 'github.com/me/c', T0 + 2, { dryRun: false })
  // Written by a's session after the merges.
  seedObservation(temp.store, { sessionId: a.sessionId, projectKey: 'github.com/me/c', host: 'claude-code', title: 'later note', at: T0 + 3 })
  expect(splitProject(db(), 'github.com/me/a', T0 + 4, { dryRun: false })).toMatchObject({ ok: true, counts: { observations: 3, sessions: 1 } })
  expect(observationKeys()).toEqual({ 'github.com/me/a': 3, 'github.com/me/c': 2 })
})

test('on a hub, keys of paired devices are never checked against the hub\'s own folders', () => {
  seedProject({ key: 'dev-abc123:/Users/me/app', kind: 'git-root', displayName: 'app' } as never, 1, T0)
  const asked: string[] = []
  backfillRoots(db(), (cwd) => (asked.push(cwd), ROOT), T0)
  expect(asked).toEqual([])
})

test('registering a key the store already holds writes nothing, with or without its first commit', () => {
  seedProject(remote('github.com/me/kinfold'), 1, T0)
  const changes = (): number => db().query<{ n: number }, []>('SELECT total_changes() AS n').get()!.n
  const before = changes()
  // The hub's context route: the key alone, once per prompt.
  for (let prompt = 0; prompt < 5; prompt += 1) expect(registerProject(db(), remote('github.com/me/kinfold', null), T0 + prompt)).toBe('github.com/me/kinfold')
  // And with the commit it already has.
  expect(registerProject(db(), remote('github.com/me/kinfold'), T0 + 10)).toBe('github.com/me/kinfold')
  expect(changes()).toBe(before)
  // A new key, and a first commit for a key that had none, are still written.
  registerProject(db(), remote('github.com/me/other', null), T0 + 20)
  registerProject(db(), remote('github.com/me/other', OTHER_ROOT), T0 + 30)
  expect(db().query('SELECT root_commit AS root FROM projects WHERE key = ?').get('github.com/me/other')).toEqual({ root: OTHER_ROOT })
})

test('a merge that fails partway leaves every row under its own key, with no half-moved project that could not be split back', () => {
  seedProject(remote('github.com/me/shared-agent-memory'), 3, T0)
  // The merge record is the last write of a merge; here it cannot be written.
  db().run("CREATE TRIGGER fail_merge_record BEFORE INSERT ON project_merges BEGIN SELECT RAISE(ABORT, 'disk full'); END")
  expect(() => registerProject(db(), remote('github.com/me/kinfold'), T0 + 1_000)).toThrow('disk full')
  expect(observationKeys()).toEqual({ 'github.com/me/shared-agent-memory': 3 })
  expect(canonicalKey(db(), 'github.com/me/shared-agent-memory')).toBe('github.com/me/shared-agent-memory')
  expect(db().query('SELECT count(*) AS n FROM projects WHERE key = ?').get('github.com/me/kinfold')).toEqual({ n: 0 })
  expect(db().query('SELECT count(*) AS n FROM project_merges').get()).toEqual({ n: 0 })
  // With the fault gone the same call merges whole.
  db().run('DROP TRIGGER fail_merge_record')
  expect(registerProject(db(), remote('github.com/me/kinfold'), T0 + 2_000)).toBe('github.com/me/kinfold')
  expect(observationKeys()).toEqual({ 'github.com/me/kinfold': 3 })
})
