import { afterEach, beforeEach, expect, test } from 'bun:test'
import { FAKE_SECRETS } from '../../../../test/fixtures/secrets'
import { type NormalizedEvent, SCHEMA_VERSION } from '../../../system/contract/event'
import { ulid } from '../../../system/contract/ulid'
import { type TempStore, openTempStore } from '../../../resources/tests/observer/test-support'
import { upsertProject, upsertSession } from '../../../resources/store/writes'
import { MAX_CAPTURE_EVENTS, captureHandler, sessionWritable } from '../../central/hub-capture'
import { centralProjectKey, parseDeviceProject } from '../../central/project-key'
import { registerProject } from '../../../resources/store/project-merge'

let temp: TempStore
beforeEach(() => {
  temp = openTempStore('kinfold-central-capture-')
})
afterEach(() => temp.cleanup())

let clock = 1_792_841_878_000
function event(overrides: Partial<NormalizedEvent> = {}): NormalizedEvent {
  clock += 1
  return { schemaVersion: SCHEMA_VERSION, eventId: ulid(clock), host: 'claude-code', hostSessionId: 'session-1', kind: 'session_start', occurredAt: clock, cwd: '/work/repo', ...overrides }
}

const context = { deviceId: 'dev-a', deviceName: 'laptop', version: '0.6.0' }
const remote = { key: 'github.com/acme/app', kind: 'git-remote' as const, displayName: 'app' }
const handler = () => captureHandler({ db: temp.store.db, prepare: { hmacKey: 'k' }, now: () => clock, onStored: () => {} })

test('a git remote key is shared across devices; a repo root or path key is scoped to its device', () => {
  expect(centralProjectKey(remote, 'dev-a')).toEqual(remote)
  expect(centralProjectKey({ key: '/home/me/scratch', kind: 'path', displayName: 'scratch' }, 'dev-a')).toEqual({ key: 'dev-a:/home/me/scratch', kind: 'path', displayName: 'scratch' })
  expect(centralProjectKey({ key: '/home/me/repo', kind: 'git-root', displayName: 'repo' }, 'dev-a').key).toBe('dev-a:/home/me/repo')
  // Already scoped keys are not scoped twice.
  expect(centralProjectKey({ key: 'dev-a:/x', kind: 'path', displayName: 'x' }, 'dev-a').key).toBe('dev-a:/x')
})

test('a device may name a shared remote key or a key scoped to itself, and nothing else', () => {
  expect(parseDeviceProject(remote, 'dev-a')).toEqual(remote)
  expect(parseDeviceProject({ key: 'dev-a:/x', kind: 'path', displayName: 'x' }, 'dev-a')).not.toBeNull()
  expect(parseDeviceProject({ key: 'dev-b:/x', kind: 'path', displayName: 'x' }, 'dev-a')).toBeNull()
  expect(parseDeviceProject({ key: '/x', kind: 'path', displayName: 'x' }, 'dev-a')).toBeNull()
  expect(parseDeviceProject({ key: 'dev-b:/x', kind: 'git-remote', displayName: 'x' }, 'dev-a')).toBeNull()
  expect(parseDeviceProject({ key: 'github.com/a/b', kind: 'other', displayName: 'x' }, 'dev-a')).toBeNull()
  expect(parseDeviceProject({ key: 'github.com/a/b', kind: 'git-remote', displayName: '' }, 'dev-a')).toBeNull()
  expect(parseDeviceProject({ key: `github.com/${'a'.repeat(5000)}/b`, kind: 'git-remote', displayName: 'b' }, 'dev-a')).toBeNull()
})

test('captured events are stored under the project key the device resolved', async () => {
  const answer = await handler()({ events: [{ event: event(), project: remote }, { event: event({ kind: 'user_prompt', promptText: 'hello' }), project: remote }] }, context)
  expect(answer).toEqual({ status: 200, body: { stored: 2, duplicates: 0, rejected: [] } })
  const sessions = temp.store.db.query('SELECT project_key AS key, cwd FROM sessions').all()
  expect(sessions).toEqual([{ key: 'github.com/acme/app', cwd: '/work/repo' }])
  expect(temp.store.db.query('SELECT text FROM prompts').all()).toEqual([{ text: 'hello' }])
})

test('the same batch sent twice stores nothing the second time', async () => {
  const batch = { events: [{ event: event(), project: remote }] }
  await handler()(batch, context)
  expect(await handler()(batch, context)).toEqual({ status: 200, body: { stored: 0, duplicates: 1, rejected: [] } })
})

test('a transcript path from the device is never kept: the hub reads no device files', async () => {
  const turn = event({ kind: 'turn_end', transcriptPath: '/Users/me/.claude/projects/x.jsonl', assistantText: 'done' })
  await handler()({ events: [{ event: turn, project: remote }] }, context)
  const payload = temp.store.db.query('SELECT payload FROM events').get() as { payload: string }
  expect(payload.payload).not.toContain('transcriptPath')
})

test('the hub runs redaction again on what arrives', async () => {
  const leaky = event({ kind: 'user_prompt', promptText: `my key is ${FAKE_SECRETS.aws} ok` })
  await handler()({ events: [{ event: leaky, project: remote }] }, context)
  const prompt = temp.store.db.query('SELECT text FROM prompts').get() as { text: string }
  expect(prompt.text).not.toContain(FAKE_SECRETS.aws)
})

test('a batch of the wrong shape stores nothing', async () => {
  for (const body of [{ events: 'all of them' }, { events: [] }, { events: Array.from({ length: MAX_CAPTURE_EVENTS + 1 }, () => ({ event: event(), project: remote })) }, null]) {
    expect((await handler()(body, context)).status).toBe(400)
  }
  expect(temp.store.db.query('SELECT COUNT(*) AS n FROM events').get()).toEqual({ n: 0 })
})

test('an invalid event or a foreign scoped key is rejected by id, and the rest of the batch is stored', async () => {
  const good = event()
  const invalid = { ...event(), schemaVersion: 99 }
  const foreign = event()
  const answer = await handler()({ events: [{ event: good, project: remote }, { event: invalid, project: remote }, { event: foreign, project: { key: 'dev-b:/x', kind: 'path', displayName: 'x' } }] }, context)
  expect(answer).toEqual({ status: 200, body: { stored: 1, duplicates: 0, rejected: [invalid.eventId, foreign.eventId] } })
})

test('a device cannot add to a session that belongs to another device\'s project or the hub\'s own', async () => {
  upsertProject(temp.store.db, { key: 'dev-b:/w/secret', kind: 'path', displayName: 'secret' }, clock)
  upsertProject(temp.store.db, { key: 'github.com/acme/app', kind: 'git-remote', displayName: 'app' }, clock)
  const theirs = upsertSession(temp.store.db, { host: 'claude-code', hostSessionId: 'their-session', projectKey: 'dev-b:/w/secret', cwd: '/w/secret', occurredAt: clock })
  upsertProject(temp.store.db, { key: '/Users/mini/private', kind: 'path', displayName: 'private' }, clock)
  upsertSession(temp.store.db, { host: 'claude-code', hostSessionId: 'hub-session', projectKey: '/Users/mini/private', cwd: '/Users/mini/private', occurredAt: clock })
  const intoTheirs = event({ hostSessionId: 'their-session', kind: 'user_prompt', promptText: 'INJECTED' })
  const intoHub = event({ hostSessionId: 'hub-session', kind: 'user_prompt', promptText: 'INJECTED' })
  const answer = await handler()({ events: [{ event: intoTheirs, project: { key: 'dev-a:/x', kind: 'path', displayName: 'x' } }, { event: intoHub, project: remote }] }, context)
  expect(answer.body).toMatchObject({ stored: 0, rejected: [intoTheirs.eventId, intoHub.eventId] })
  expect(temp.store.db.query("SELECT COUNT(*) AS n FROM prompts WHERE text = 'INJECTED'").get()).toEqual({ n: 0 })
  expect(theirs).toBeGreaterThan(0)
  // Its own scoped sessions and shared remote sessions stay open to it, wherever the session moved since.
  upsertSession(temp.store.db, { host: 'claude-code', hostSessionId: 'shared-session', projectKey: 'github.com/acme/app', cwd: '/w', occurredAt: clock })
  const shared = event({ hostSessionId: 'shared-session', kind: 'user_prompt', promptText: 'ok' })
  expect((await handler()({ events: [{ event: shared, project: { key: 'dev-a:/elsewhere', kind: 'path', displayName: 'e' } }] }, context)).body).toMatchObject({ stored: 1, rejected: [] })
})

test('a remote whose host is an SSH alias or an IPv6 address is a shared key', () => {
  expect(parseDeviceProject({ key: 'github_work/me/repo', kind: 'git-remote', displayName: 'repo' }, 'dev-a')).not.toBeNull()
  expect(parseDeviceProject({ key: '[fd00::1]/me/repo', kind: 'git-remote', displayName: 'repo' }, 'dev-a')).not.toBeNull()
  expect(parseDeviceProject({ key: 'dev-b:x/me/repo', kind: 'git-remote', displayName: 'repo' }, 'dev-a')).toBeNull()
})

test('a stored batch wakes the observer', async () => {
  let woken = 0
  const capture = captureHandler({ db: temp.store.db, prepare: { hmacKey: 'k' }, now: () => clock, onStored: () => { woken += 1 } })
  await capture({ events: [{ event: event(), project: remote }] }, context)
  await capture({ events: [{ event: event(), project: remote }].map((item) => item) }, context)
  expect(woken).toBe(2)
})

test('a device sends its repo\'s first commit, so the hub can tell the same repo under two keys; a malformed one is dropped', () => {
  const rootCommit = 'd'.repeat(40)
  expect(parseDeviceProject({ ...remote, rootCommit }, 'dev-a')).toEqual({ ...remote, rootCommit })
  expect(parseDeviceProject({ ...remote, rootCommit: 'not-a-commit' }, 'dev-a')).toEqual(remote)
  expect(centralProjectKey({ key: '/home/me/repo', kind: 'git-root', displayName: 'repo', rootCommit }, 'dev-a')).toMatchObject({ key: 'dev-a:/home/me/repo', rootCommit })
})

test('after one repo\'s keys merged on the hub, a device still writes its sessions there', () => {
  const temp = openTempStore('kinfold-writable-')
  try {
    const db = temp.store.db
    const root = 'f'.repeat(40)
    registerProject(db, { key: 'dev-a:/repo', kind: 'git-root', displayName: 'repo', rootCommit: root }, 1)
    // A later key of the same repo wins, and the device's session moves under it.
    const winner = registerProject(db, { key: 'dev-b:/repo', kind: 'git-root', displayName: 'repo', rootCommit: root }, 2)
    upsertSession(db, { host: 'claude-code', hostSessionId: 's', projectKey: winner, cwd: '/repo', occurredAt: 3 })
    expect(sessionWritable(db, 'claude-code', 's', 'dev-a:/repo', 'dev-a')).toBe(true)
    expect(sessionWritable(db, 'claude-code', 's', 'dev-c:/other', 'dev-c')).toBe(false)
  } finally {
    temp.cleanup()
  }
})
