// Shared test scaffolding for the observer: a temp store, seeded sessions and
// events with synthetic payloads, and fake runners. Tests only; nothing in the
// daemon imports it.

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ToolCall } from '../contract/event'
import { ulid } from '../contract/ulid'
import { type Store, openStore } from '../store/db'
import { insertEvent, upsertProject, upsertSession } from '../store/writes'
import type { ObserverPrompt, ObserverRunner, RunnerResult } from './types'

export interface TempStore {
  root: string
  dataDir: string
  store: Store
  cleanup: () => void
}

export function openTempStore(prefix: string): TempStore {
  const root = mkdtempSync(join(tmpdir(), prefix))
  const dataDir = join(root, 'data')
  const store = openStore(dataDir)
  return {
    root,
    dataDir,
    store,
    cleanup: () => {
      store.db.close()
      rmSync(root, { recursive: true, force: true })
    },
  }
}

export const T0 = 1_792_845_000_000
export const PROJECT = 'org/repo'

export function seedSession(store: Store, host: string, hostSessionId: string, at: number = T0): number {
  upsertProject(store.db, { key: PROJECT, kind: 'git-remote', displayName: 'repo' }, at)
  return upsertSession(store.db, { host, hostSessionId, projectKey: PROJECT, cwd: '/work/repo', occurredAt: at })
}

export interface SeedEvent {
  kind: 'session_start' | 'user_prompt' | 'tool_result' | 'turn_end' | 'session_end'
  at: number
  promptNumber?: number | null
  promptText?: string
  assistantText?: string
  tool?: Pick<ToolCall, 'name' | 'output'> & Partial<Pick<ToolCall, 'exitCode' | 'withheld' | 'input'>>
}

let sequence = 0

/** Inserts one event row and bumps the session's last_event_at; returns its event_id. */
export function seedEvent(store: Store, sessionId: number, seed: SeedEvent): string {
  sequence += 1
  const eventId = ulid(seed.at + sequence)
  const tool = seed.tool !== undefined ? { input: { command: 'test' }, ...seed.tool } : undefined
  const payload = { eventId, kind: seed.kind, occurredAt: seed.at, promptText: seed.promptText, assistantText: seed.assistantText, tool }
  insertEvent(store.db, {
    eventId,
    sessionId,
    promptNumber: seed.promptNumber ?? null,
    kind: seed.kind,
    toolName: tool?.name ?? null,
    payload: JSON.stringify(payload),
    withheld: tool?.withheld ?? null,
    redactions: '[]',
    contentHash: eventId,
    occurredAt: seed.at,
    ingestedAt: seed.at,
  })
  store.db.query('UPDATE sessions SET last_event_at = max(last_event_at, $at) WHERE id = $sessionId').run({ at: seed.at, sessionId })
  return eventId
}

export interface FakeRunner extends ObserverRunner {
  prompts: ObserverPrompt[]
}

/** Answers each call with the next reply; a function reply sees the prompt (to cite its ids). */
export function fakeRunner(replies: readonly (string | Error | ((prompt: ObserverPrompt) => string))[], model: string = 'fake-model'): FakeRunner {
  const prompts: ObserverPrompt[] = []
  return {
    prompts,
    run: async (prompt): Promise<RunnerResult> => {
      const reply = replies[Math.min(prompts.length, replies.length - 1)]
      prompts.push(prompt)
      if (reply instanceof Error) throw reply
      return { text: typeof reply === 'function' ? reply(prompt) : (reply ?? '{}'), model }
    },
  }
}

export function stateCounts(store: Store, sessionId: number): Record<string, number> {
  const rows = store.db.query<{ state: string; n: number }, { sessionId: number }>(
    'SELECT observer_state AS state, count(*) AS n FROM events WHERE session_id = $sessionId GROUP BY observer_state',
  ).all({ sessionId })
  return Object.fromEntries(rows.map((row) => [row.state, row.n]))
}
