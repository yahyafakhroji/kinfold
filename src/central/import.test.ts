import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { insertObservation, upsertSummary } from '../store/observer-store'
import { type Store, openStore } from '../store/db'
import { insertPrompt, setPromptReply, upsertProject, upsertSession } from '../store/writes'
import { FAKE_SECRETS } from '../../test/fixtures/secrets'
import { exportProject, importChunk, listLocalProjects, openLocalStore } from './import'

let root: string
let local: Store
let hub: Store
const T0 = 1_792_900_000_000
const PREPARE = { hmacKey: 'hub-key' }

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'kinfold-central-import-'))
  local = openStore(join(root, 'device'))
  hub = openStore(join(root, 'hub'))
})
afterEach(() => {
  local.db.close()
  hub.db.close()
  if (root.startsWith(tmpdir())) rmSync(root, { recursive: true, force: true })
})

function seedLocal(key: string, kind: 'git-remote' | 'path', sessionId: string, title: string): void {
  upsertProject(local.db, { key, kind, displayName: 'app' }, T0)
  const session = upsertSession(local.db, { host: 'claude-code', hostSessionId: sessionId, projectKey: key, cwd: '/w/app', occurredAt: T0 })
  insertPrompt(local.db, { sessionId: session, promptNumber: 1, text: 'how do we pin bun', occurredAt: T0 + 1 })
  setPromptReply(local.db, session, 1, 'with .bun-version')
  upsertSummary(local.db, { sessionId: session, promptNumber: 1, request: 'pin bun', learned: 'bun-version file', completed: 'done', nextSteps: '', occurredAt: T0 + 2, updatedAt: T0 + 2 })
  insertObservation(local.db, {
    projectKey: key, sessionId: session, host: 'claude-code', promptNumber: 1, type: 'discovery', title, narrative: 'n', facts: '[]', files: '[]',
    evidence: 'tool-verified', sourceEventIds: '[]', observerModel: 'm', contentHash: `hash-${title}`, occurredAt: T0 + 3, createdAt: T0 + 3,
  })
}

const counts = (store: Store) => store.db.query(`SELECT
  (SELECT COUNT(*) FROM sessions) AS sessions, (SELECT COUNT(*) FROM prompts) AS prompts,
  (SELECT COUNT(*) FROM summaries) AS summaries, (SELECT COUNT(*) FROM observations) AS observations`).get()

test('a local project exports in chunks the hub stores whole: sessions, prompts with replies, summaries and observations', () => {
  seedLocal('github.com/acme/app', 'git-remote', 's-1', 'Bun is pinned')
  const reader = openLocalStore(join(root, 'device'))!
  const chunks = [...exportProject(reader, { key: 'github.com/acme/app', kind: 'git-remote', displayName: 'app' }, 'dev-a')]
  reader.close()
  expect(chunks.length).toBe(1)
  const result = importChunk(hub.db, chunks[0], 'dev-a', T0 + 10, PREPARE)
  expect(result).toEqual({ status: 200, body: { sessions: 1, prompts: 1, summaries: 1, observations: 1, skippedSessions: 0 } })
  expect(counts(hub)).toEqual({ sessions: 1, prompts: 1, summaries: 1, observations: 1 })
  expect(hub.db.query('SELECT reply_text AS reply FROM prompts').get()).toEqual({ reply: 'with .bun-version' })
  expect(hub.db.query('SELECT device FROM sessions').get()).toEqual({ device: 'dev-a' })
  expect(hub.db.query('SELECT title, project_key AS key FROM observations').get()).toEqual({ title: 'Bun is pinned', key: 'github.com/acme/app' })
  // The FTS index is fed by the same triggers as any other observation, so search finds it.
  expect(hub.db.query("SELECT COUNT(*) AS n FROM observations_fts WHERE observations_fts MATCH 'pinned'").get()).toEqual({ n: 1 })
})

test('importing again adds nothing the hub already has, and adds what it lacks', () => {
  seedLocal('github.com/acme/app', 'git-remote', 's-1', 'Bun is pinned')
  const project = { key: 'github.com/acme/app', kind: 'git-remote' as const, displayName: 'app' }
  let reader = openLocalStore(join(root, 'device'))!
  for (const chunk of exportProject(reader, project, 'dev-a')) importChunk(hub.db, chunk, 'dev-a', T0, PREPARE)
  reader.close()
  seedLocal('github.com/acme/app', 'git-remote', 's-2', 'A second memory')
  reader = openLocalStore(join(root, 'device'))!
  const results = [...exportProject(reader, project, 'dev-a')].map((chunk) => importChunk(hub.db, chunk, 'dev-a', T0, PREPARE).body)
  reader.close()
  expect(results).toEqual([{ sessions: 1, prompts: 1, summaries: 1, observations: 1, skippedSessions: 0 }])
  expect(counts(hub)).toEqual({ sessions: 2, prompts: 2, summaries: 2, observations: 2 })
})

test('a path project lands under this device\'s scope, and a chunk naming another device\'s scope is refused', () => {
  seedLocal('/home/me/scratch', 'path', 's-1', 'Scratch note')
  const reader = openLocalStore(join(root, 'device'))!
  const [chunk] = [...exportProject(reader, { key: '/home/me/scratch', kind: 'path', displayName: 'scratch' }, 'dev-a')]
  reader.close()
  expect(importChunk(hub.db, chunk, 'dev-a', T0, PREPARE).status).toBe(200)
  expect(hub.db.query('SELECT key FROM projects').all()).toEqual([{ key: 'dev-a:/home/me/scratch' }])
  expect(importChunk(hub.db, chunk, 'dev-b', T0, PREPARE).status).toBe(400)
})

test('chunks that are not the expected shape are refused whole', () => {
  for (const body of [null, {}, { project: { key: 'github.com/a/b', kind: 'git-remote', displayName: 'b' }, sessions: 'x', observations: [] },
    { project: { key: 'github.com/a/b', kind: 'git-remote', displayName: 'b' }, sessions: [{ host: 'Bad Host' }], observations: [] },
    { project: { key: 'github.com/a/b', kind: 'git-remote', displayName: 'b' }, sessions: [], observations: [{ title: 'x', evidence: 'made-up' }] }]) {
    expect(importChunk(hub.db, body, 'dev-a', T0, PREPARE).status).toBe(400)
  }
  expect(counts(hub)).toEqual({ sessions: 0, prompts: 0, summaries: 0, observations: 0 })
})

test('the local projects are listed with their kinds', () => {
  seedLocal('github.com/acme/app', 'git-remote', 's-1', 'a')
  seedLocal('/home/me/scratch', 'path', 's-2', 'b')
  const reader = openLocalStore(join(root, 'device'))!
  expect(listLocalProjects(reader)).toEqual([
    { key: '/home/me/scratch', kind: 'path', displayName: 'app' },
    { key: 'github.com/acme/app', kind: 'git-remote', displayName: 'app' },
  ])
  reader.close()
})

test('a long session is split across chunks under the byte budget, and the hub ends up with all of it', () => {
  upsertProject(local.db, { key: 'github.com/acme/app', kind: 'git-remote', displayName: 'app' }, T0)
  const session = upsertSession(local.db, { host: 'claude-code', hostSessionId: 'long', projectKey: 'github.com/acme/app', cwd: '/w', occurredAt: T0 })
  for (let number = 1; number <= 30; number += 1) insertPrompt(local.db, { sessionId: session, promptNumber: number, text: '語'.repeat(1_000), occurredAt: T0 + number })
  const reader = openLocalStore(join(root, 'device'))!
  const chunks = [...exportProject(reader, { key: 'github.com/acme/app', kind: 'git-remote', displayName: 'app' }, 'dev-a', 20_000)]
  reader.close()
  expect(chunks.length).toBeGreaterThan(3)
  for (const chunk of chunks) expect(Buffer.byteLength(JSON.stringify(chunk))).toBeLessThanOrEqual(20_000)
  for (const chunk of chunks) expect(importChunk(hub.db, chunk, 'dev-a', T0, PREPARE).status).toBe(200)
  expect(counts(hub)).toEqual({ sessions: 1, prompts: 30, summaries: 0, observations: 0 })
})

test('the hub redacts imported text again with its own rules', () => {
  upsertProject(local.db, { key: 'github.com/acme/app', kind: 'git-remote', displayName: 'app' }, T0)
  const session = upsertSession(local.db, { host: 'claude-code', hostSessionId: 's-leak', projectKey: 'github.com/acme/app', cwd: '/w', occurredAt: T0 })
  insertPrompt(local.db, { sessionId: session, promptNumber: 1, text: `key ${FAKE_SECRETS.aws}`, occurredAt: T0 })
  const reader = openLocalStore(join(root, 'device'))!
  for (const chunk of exportProject(reader, { key: 'github.com/acme/app', kind: 'git-remote', displayName: 'app' }, 'dev-a')) importChunk(hub.db, chunk, 'dev-a', T0, PREPARE)
  reader.close()
  expect(String((hub.db.query('SELECT text FROM prompts').get() as { text: string }).text)).not.toContain(FAKE_SECRETS.aws)
})

test('an import cannot add to a session that belongs to another device\'s folder', () => {
  upsertProject(hub.db, { key: 'dev-b:/w/secret', kind: 'path', displayName: 'secret' }, T0)
  upsertSession(hub.db, { host: 'claude-code', hostSessionId: 'their-session', projectKey: 'dev-b:/w/secret', cwd: '/w/secret', occurredAt: T0 })
  const chunk = { project: { key: 'dev-a:/x', kind: 'path', displayName: 'x' }, observations: [],
    sessions: [{ host: 'claude-code', hostSessionId: 'their-session', cwd: '/x', hostVersion: null, startedAt: T0, endedAt: null, lastEventAt: T0, summaries: [],
      prompts: [{ number: 9, hostPromptId: null, text: 'INJECTED', reply: null, occurredAt: T0 }] }] }
  expect(importChunk(hub.db, chunk, 'dev-a', T0, PREPARE)).toEqual({ status: 200, body: { sessions: 0, prompts: 0, summaries: 0, observations: 0, skippedSessions: 1 } })
  expect(hub.db.query("SELECT COUNT(*) AS n FROM prompts WHERE text = 'INJECTED'").get()).toEqual({ n: 0 })
})

test('a project the hub merged into another is imported under the key it merged into', () => {
  upsertProject(hub.db, { key: 'github.com/me/kinfold', kind: 'git-remote', displayName: 'kinfold' }, T0)
  upsertProject(hub.db, { key: 'dev-a:/x', kind: 'path', displayName: 'x' }, T0)
  hub.db.query('UPDATE projects SET merged_into = ? WHERE key = ?').run('github.com/me/kinfold', 'dev-a:/x')
  const chunk = { project: { key: 'dev-a:/x', kind: 'path', displayName: 'x' }, observations: [],
    sessions: [{ host: 'claude-code', hostSessionId: 'mine', cwd: '/x', hostVersion: null, startedAt: T0, endedAt: null, lastEventAt: T0, summaries: [], prompts: [] }] }
  expect(importChunk(hub.db, chunk, 'dev-a', T0, PREPARE)).toMatchObject({ status: 200, body: { sessions: 1 } })
  expect(hub.db.query("SELECT project_key AS key FROM sessions WHERE host_session_id = 'mine'").get()).toEqual({ key: 'github.com/me/kinfold' })
})

test('an observation cannot name another device\'s session the chunk does not list, and one with no such session still imports', () => {
  upsertProject(hub.db, { key: 'dev-b:/w/secret', kind: 'path', displayName: 'secret' }, T0)
  const theirs = upsertSession(hub.db, { host: 'claude-code', hostSessionId: 'their-session', projectKey: 'dev-b:/w/secret', cwd: '/w/secret', occurredAt: T0 })
  const observation = (title: string, session: { host: string; hostSessionId: string } | null) => ({
    session, host: 'claude-code', promptNumber: 1, type: 'discovery', title, narrative: 'n', facts: '[]', files: '[]', evidence: 'tool-verified',
    sourceEventIds: '[]', observerModel: 'm', contentHash: `hash-${title}`, occurredAt: T0, createdAt: T0,
  })
  const chunk = { project: { key: 'dev-a:/x', kind: 'path', displayName: 'x' }, sessions: [],
    observations: [observation('ATTACHED', { host: 'claude-code', hostSessionId: 'their-session' }), observation('loose', null), observation('unknown session', { host: 'claude-code', hostSessionId: 'never-seen' })] }
  expect(importChunk(hub.db, chunk, 'dev-a', T0, PREPARE)).toEqual({ status: 200, body: { sessions: 0, prompts: 0, summaries: 0, observations: 2, skippedSessions: 1 } })
  expect(hub.db.query('SELECT COUNT(*) AS n FROM observations WHERE session_id = $id').get({ id: theirs })).toEqual({ n: 0 })
  expect(hub.db.query("SELECT COUNT(*) AS n FROM observations WHERE title = 'ATTACHED'").get()).toEqual({ n: 0 })
  expect(hub.db.query('SELECT title, session_id AS session FROM observations ORDER BY title').all()).toEqual([{ title: 'loose', session: null }, { title: 'unknown session', session: null }])
})
