// Moving a device's local memory of one project into the hub. The device
// reads its own store read-only and sends the project in chunks; the hub
// stores whatever it does not have yet, matched by what names a row on every
// machine: a session by its host and host session id, a prompt or summary by
// its session and prompt number, an observation by its project and content
// hash. Sending a chunk twice adds nothing. Raw events, observation links and
// vectors stay behind: the hub embeds imported observations in its own space.
// Observations already superseded on the device are not sent.

import { join } from 'node:path'
import { openReadOnly } from '../context/fallback'
import type { DbKeyStore } from '../sqlite/keys'
import type { Database } from '../sqlite/types'
import { DB_FILE } from '../store/data-dir'
import type { ProjectKey, ProjectKeyKind } from '../store/project-key'
import { registerProject } from '../store/project-merge'
import { type PrepareOptions, cleanText } from '../capture/prepare'
import { sessionWritable } from './hub-capture'
import type { HubAnswer } from './hub-server'
import { centralProjectKey, parseDeviceProject } from './project-key'
import { isRecord } from '../contract/event'

/** Well under the hub's 4 MB cap. */
export const IMPORT_CHUNK_BYTES = 1_500_000
const MAX_SESSIONS = 2_000
const MAX_ROWS = 20_000
const MAX_TEXT = 200_000

export interface ImportPrompt { number: number; hostPromptId: string | null; text: string; reply: string | null; occurredAt: number }
export interface ImportSummary { promptNumber: number; request: string | null; learned: string | null; completed: string | null; nextSteps: string | null; occurredAt: number; updatedAt: number }
export interface ImportSession {
  host: string; hostSessionId: string; cwd: string; hostVersion: string | null; startedAt: number; endedAt: number | null; lastEventAt: number
  prompts: ImportPrompt[]; summaries: ImportSummary[]
}
export interface ImportObservation {
  session: { host: string; hostSessionId: string } | null
  host: string; promptNumber: number | null; type: string; title: string; narrative: string; facts: string; files: string
  evidence: string; sourceEventIds: string; observerModel: string | null; contentHash: string; occurredAt: number; createdAt: number
}
export interface ImportChunk { project: ProjectKey; sessions: ImportSession[]; observations: ImportObservation[] }

/** The device's store, read-only; null when it has none. */
export function openLocalStore(dataDir: string, keys?: DbKeyStore): Database | null {
  return openReadOnly(join(dataDir, DB_FILE), undefined, keys)
}

export function listLocalProjects(db: Database): ProjectKey[] {
  return (db.query('SELECT key, key_kind AS kind, display_name AS displayName FROM projects ORDER BY key').all() as { key: string; kind: ProjectKeyKind; displayName: string }[])
    .map(({ key, kind, displayName }) => ({ key, kind, displayName }))
}

interface SessionRow { id: number; host: string; hostSessionId: string; cwd: string; hostVersion: string | null; startedAt: number; endedAt: number | null; lastEventAt: number }

function promptsOf(db: Database, id: number): ImportPrompt[] {
  return db.query(`SELECT prompt_number AS number, host_prompt_id AS hostPromptId, text, reply_text AS reply, occurred_at AS occurredAt
    FROM prompts WHERE session_id = $id AND text_expired_at IS NULL ORDER BY prompt_number`).all({ id }) as ImportPrompt[]
}

function summariesOf(db: Database, id: number): ImportSummary[] {
  return db.query(`SELECT prompt_number AS promptNumber, request, learned, completed, next_steps AS nextSteps, occurred_at AS occurredAt, updated_at AS updatedAt
    FROM summaries WHERE session_id = $id ORDER BY prompt_number`).all({ id }) as ImportSummary[]
}

function observationsOf(db: Database, projectKey: string, sessionId: number | null): ImportObservation[] {
  const where = sessionId === null ? 'o.session_id IS NULL' : 'o.session_id = $session'
  const rows = db.query(`SELECT s.host AS sessionHost, s.host_session_id AS sessionHostId, o.host, o.prompt_number AS promptNumber, o.type, o.title, o.narrative,
      o.facts, o.files, o.evidence, o.source_event_ids AS sourceEventIds, o.observer_model AS observerModel, o.content_hash AS contentHash,
      o.occurred_at AS occurredAt, o.created_at AS createdAt
    FROM observations o LEFT JOIN sessions s ON s.id = o.session_id
    WHERE o.project_key = $key AND o.contradicted_by IS NULL AND ${where} ORDER BY o.id`).all({ key: projectKey, ...(sessionId === null ? {} : { session: sessionId }) }) as (Omit<ImportObservation, 'session'> & { sessionHost: string | null; sessionHostId: string | null })[]
  return rows.map(({ sessionHost, sessionHostId, ...rest }) => ({ ...rest, session: sessionHost === null || sessionHostId === null ? null : { host: sessionHost, hostSessionId: sessionHostId } }))
}

type Piece = { session: ImportSession | null; prompt?: ImportPrompt; summary?: ImportSummary; observation?: ImportObservation }

const bytesOf = (value: unknown): number => Buffer.byteLength(JSON.stringify(value))

/** One chunk under construction: each session it names, with the prompts and summaries it carries so far. */
class ChunkBuilder {
  private sessions = new Map<string, ImportSession>()
  private observations: ImportObservation[] = []
  private bytes: number

  constructor(private readonly project: ProjectKey) {
    this.bytes = bytesOf({ project, sessions: [], observations: [] })
  }

  get empty(): boolean {
    return this.sessions.size === 0 && this.observations.length === 0
  }

  /** What adding the piece would cost: its own bytes, and its session's header when the chunk does not carry it yet. */
  cost(piece: Piece): number {
    const header = piece.session === null || this.sessions.has(sessionKey(piece.session)) ? 0 : bytesOf({ ...piece.session, prompts: [], summaries: [] }) + 1
    const row = piece.prompt ?? piece.summary ?? piece.observation
    return header + (row === undefined ? 0 : bytesOf(row) + 1)
  }

  /** `cost` is what cost(piece) answered, so the piece is turned into JSON once and not twice. */
  add(piece: Piece, cost: number): void {
    this.bytes += cost
    if (piece.session !== null) {
      const key = sessionKey(piece.session)
      // The arrays are this builder's own, so a session of thousands of prompts is appended to, not copied per prompt.
      const held = this.sessions.get(key) ?? { ...piece.session, prompts: [], summaries: [] }
      if (piece.prompt !== undefined) held.prompts.push(piece.prompt)
      if (piece.summary !== undefined) held.summaries.push(piece.summary)
      this.sessions.set(key, held)
    }
    if (piece.observation !== undefined) this.observations.push(piece.observation)
  }

  get size(): number {
    return this.bytes
  }

  build(): ImportChunk {
    return { project: this.project, sessions: [...this.sessions.values()], observations: this.observations }
  }
}

const sessionKey = (session: Pick<ImportSession, 'host' | 'hostSessionId'>): string => `${session.host}\n${session.hostSessionId}`

function* piecesOf(db: Database, project: ProjectKey): Generator<Piece> {
  const sessions = db.query(`SELECT id, host, host_session_id AS hostSessionId, cwd, host_version AS hostVersion, started_at AS startedAt, ended_at AS endedAt,
    last_event_at AS lastEventAt FROM sessions WHERE project_key = $key ORDER BY id`).all({ key: project.key }) as SessionRow[]
  for (const { id, ...row } of sessions) {
    const session: ImportSession = { ...row, prompts: [], summaries: [] }
    // The header alone, so a session with nothing else still reaches the hub.
    yield { session }
    for (const prompt of promptsOf(db, id)) yield { session, prompt }
    for (const summary of summariesOf(db, id)) yield { session, summary }
    for (const observation of observationsOf(db, project.key, id)) yield { session, observation }
  }
  for (const observation of observationsOf(db, project.key, null)) yield { session: null, observation }
}

/**
 * The project's rows in chunks of at most `chunkBytes` (counted in bytes, as
 * the hub counts them), under its central key. A long session is split
 * across chunks; each chunk repeats the session's header so the hub can
 * find or make the session for whatever that chunk carries.
 */
export function* exportProject(db: Database, project: ProjectKey, deviceId: string, chunkBytes: number = IMPORT_CHUNK_BYTES): Generator<ImportChunk> {
  const central = centralProjectKey(project, deviceId)
  let chunk = new ChunkBuilder(central)
  for (const piece of piecesOf(db, project)) {
    let cost = chunk.cost(piece)
    if (!chunk.empty && chunk.size + cost > chunkBytes) {
      yield chunk.build()
      chunk = new ChunkBuilder(central)
      // A new chunk carries the session's header again.
      cost = chunk.cost(piece)
    }
    chunk.add(piece, cost)
  }
  if (!chunk.empty) yield chunk.build()
}

// ---- The hub's side ----

const HOST = /^[a-z][a-z0-9-]{1,31}$/
const EVIDENCE = new Set(['tool-verified', 'interpretation', 'user-stated'])
const isTime = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0
const isCount = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0
const isText = (value: unknown, max = MAX_TEXT): value is string => typeof value === 'string' && value.length <= max
const isOptionalText = (value: unknown, max = MAX_TEXT): value is string | null => value === null || isText(value, max)

function validPrompt(value: unknown): value is ImportPrompt {
  return isRecord(value) && isCount(value.number) && isOptionalText(value.hostPromptId, 256) && isText(value.text) && isOptionalText(value.reply) && isTime(value.occurredAt)
}

function validSummary(value: unknown): value is ImportSummary {
  return isRecord(value) && isCount(value.promptNumber) && ['request', 'learned', 'completed', 'nextSteps'].every((key) => isOptionalText(value[key])) && isTime(value.occurredAt) && isTime(value.updatedAt)
}

function validSession(value: unknown): value is ImportSession {
  return isRecord(value) && typeof value.host === 'string' && HOST.test(value.host) && isText(value.hostSessionId, 256) && value.hostSessionId !== ''
    && isText(value.cwd, 4_096) && isOptionalText(value.hostVersion, 64) && isTime(value.startedAt) && (value.endedAt === null || isTime(value.endedAt)) && isTime(value.lastEventAt)
    && Array.isArray(value.prompts) && value.prompts.length <= MAX_ROWS && value.prompts.every(validPrompt)
    && Array.isArray(value.summaries) && value.summaries.length <= MAX_ROWS && value.summaries.every(validSummary)
}

function validObservation(value: unknown): value is ImportObservation {
  if (!isRecord(value)) return false
  const session = value.session
  const sessionOk = session === null || (isRecord(session) && typeof session.host === 'string' && HOST.test(session.host) && isText(session.hostSessionId, 256))
  return sessionOk && typeof value.host === 'string' && HOST.test(value.host) && (value.promptNumber === null || isCount(value.promptNumber))
    && isText(value.type, 64) && isText(value.title, 1_000) && value.title !== '' && isText(value.narrative) && isText(value.facts) && isText(value.files)
    && typeof value.evidence === 'string' && EVIDENCE.has(value.evidence) && isText(value.sourceEventIds) && isOptionalText(value.observerModel, 256)
    && isText(value.contentHash, 128) && value.contentHash !== '' && isTime(value.occurredAt) && isTime(value.createdAt)
}

function parseChunk(body: unknown, deviceId: string): ImportChunk | null {
  if (!isRecord(body)) return null
  const project = parseDeviceProject(body.project, deviceId)
  const { sessions, observations } = body
  if (project === null || !Array.isArray(sessions) || sessions.length > MAX_SESSIONS || !sessions.every(validSession)) return null
  if (!Array.isArray(observations) || observations.length > MAX_ROWS || !observations.every(validObservation)) return null
  return { project, sessions, observations }
}

function sessionId(db: Database, host: string, hostSessionId: string): number | null {
  const row = db.query('SELECT id FROM sessions WHERE host = $host AND host_session_id = $hostSessionId').get({ host, hostSessionId }) as { id: number } | null
  return row?.id ?? null
}

/**
 * Stores the rows of one chunk the hub lacks, in one transaction; counts what
 * was added. Text is redacted again with the hub's own rules, as captures
 * are. A session that already belongs to another device's folder or to the
 * hub's own is skipped whole.
 */
export function importChunk(db: Database, body: unknown, deviceId: string, now: number, prepare: PrepareOptions): HubAnswer {
  const chunk = parseChunk(body, deviceId)
  if (chunk === null) return { status: 400, body: { error: 'body must be one import chunk with this device\'s project key' } }
  const clean = (text: string, field: string): string => cleanText(text, field, prepare).value
  const cleanOrNull = (text: string | null, field: string): string | null => (text === null ? null : clean(text, field))
  const added = db.transaction(() => {
    const counts = { sessions: 0, prompts: 0, summaries: 0, observations: 0, skippedSessions: 0 }
    const skipped = new Set<string>()
    // A key the hub merged into another (store/project-merge.ts) imports under that one.
    const projectKey = registerProject(db, chunk.project, now)
    for (const session of chunk.sessions) {
      if (!sessionWritable(db, session.host, session.hostSessionId, chunk.project.key, deviceId)) {
        skipped.add(sessionKey(session))
        counts.skippedSessions += 1
        continue
      }
      let id = sessionId(db, session.host, session.hostSessionId)
      if (id === null) {
        db.query(`INSERT INTO sessions (host, host_session_id, project_key, cwd, host_version, started_at, ended_at, last_event_at, device)
          VALUES ($host, $hostSessionId, $projectKey, $cwd, $hostVersion, $startedAt, $endedAt, $lastEventAt, $device)`)
          .run({ device: deviceId, host: session.host, hostSessionId: session.hostSessionId, projectKey, cwd: session.cwd, hostVersion: session.hostVersion, startedAt: session.startedAt, endedAt: session.endedAt, lastEventAt: session.lastEventAt })
        id = sessionId(db, session.host, session.hostSessionId)!
        counts.sessions += 1
      }
      for (const prompt of session.prompts) {
        counts.prompts += db.query(`INSERT OR IGNORE INTO prompts (session_id, prompt_number, host_prompt_id, text, reply_text, occurred_at)
          VALUES ($id, $number, $hostPromptId, $text, $reply, $occurredAt)`).run({ id, number: prompt.number, hostPromptId: prompt.hostPromptId, text: clean(prompt.text, 'prompt'), reply: cleanOrNull(prompt.reply, 'reply'), occurredAt: prompt.occurredAt }).changes
      }
      for (const summary of session.summaries) {
        counts.summaries += db.query(`INSERT OR IGNORE INTO summaries (session_id, prompt_number, request, learned, completed, next_steps, occurred_at, updated_at)
          VALUES ($id, $promptNumber, $request, $learned, $completed, $nextSteps, $occurredAt, $updatedAt)`).run({
          id, ...summary, request: cleanOrNull(summary.request, 'summary'), learned: cleanOrNull(summary.learned, 'summary'), completed: cleanOrNull(summary.completed, 'summary'), nextSteps: cleanOrNull(summary.nextSteps, 'summary'),
        }).changes
      }
    }
    for (const observation of chunk.observations) {
      // An observation may name a session this chunk does not list. It is held to the same rule as a listed one:
      // a device cannot attach a memory to another device's session, or to one of the hub's own.
      if (observation.session !== null && !skipped.has(sessionKey(observation.session)) && !sessionWritable(db, observation.session.host, observation.session.hostSessionId, chunk.project.key, deviceId)) {
        skipped.add(sessionKey(observation.session))
        counts.skippedSessions += 1
      }
      if (observation.session !== null && skipped.has(sessionKey(observation.session))) continue
      const session = observation.session === null ? null : sessionId(db, observation.session.host, observation.session.hostSessionId)
      const { session: _ref, ...raw } = observation
      const row = { ...raw, title: clean(raw.title, 'title'), narrative: clean(raw.narrative, 'narrative'), facts: clean(raw.facts, 'facts') }
      counts.observations += db.query(`INSERT INTO observations (project_key, session_id, host, prompt_number, type, title, narrative, facts, files, evidence,
          source_event_ids, observer_model, content_hash, occurred_at, created_at)
        SELECT $projectKey, $sessionId, $host, $promptNumber, $type, $title, $narrative, $facts, $files, $evidence, $sourceEventIds, $observerModel, $contentHash, $occurredAt, $createdAt
        WHERE NOT EXISTS (SELECT 1 FROM observations WHERE project_key = $projectKey AND content_hash = $contentHash)`).run({ ...row, projectKey, sessionId: session }).changes
    }
    return counts
  })()
  return { status: 200, body: added }
}

/** Which of these central keys the hub already holds. */
export function knownProjects(db: Database, keys: readonly string[]): string[] {
  return keys.filter((key) => db.query('SELECT 1 FROM projects WHERE key = $key').get({ key }) !== null)
}
