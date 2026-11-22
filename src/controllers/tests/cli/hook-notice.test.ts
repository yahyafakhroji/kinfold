import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ContextRequest, ContextResult } from '../context/types'
import { runHook } from './hook'

const FIXTURES = join(import.meta.dir, '../../test/fixtures')
const NOTICE = { version: '0.2.0', channel: 'curl' } as const

let root: string
let dataDir: string
let asked: ContextRequest[]
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'kinfold-hook-notice-'))
  dataDir = join(root, 'data')
  mkdirSync(dataDir, { recursive: true })
  writeFileSync(join(dataDir, 'daemon.json'), JSON.stringify({ pid: process.pid, port: 4 }))
  writeFileSync(join(dataDir, 'daemon.token'), 'a'.repeat(64))
  // The recall line has its own tests (hook-recall.test.ts); with it off, these pin the notice alone.
  writeFileSync(join(dataDir, 'display.json'), '{"showRecall":false}')
  asked = []
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

const payload = (host: string, name: string): string => {
  const raw = JSON.parse(readFileSync(join(FIXTURES, host, `${name}.json`), 'utf8')) as Record<string, unknown>
  return JSON.stringify(host === 'cursor' ? { ...raw, workspace_roots: [root] } : { ...raw, cwd: root })
}

function run(host: 'claude-code' | 'codex' | 'cursor', name: string, answer: Partial<ContextResult>): Promise<string | null> {
  const fetchFake = async (_url: string, init: RequestInit): Promise<Response> => {
    asked.push(JSON.parse(String(init.body)) as ContextRequest)
    return new Response(JSON.stringify({ text: '', observationIds: [], tokens: 0, ...answer }))
  }
  return runHook(payload(host, name), dataDir, () => undefined, {}, { fetch: fetchFake, fallback: false }, host)
}

test('Claude Code gets a systemMessage, not a context line', async () => {
  const out = JSON.parse((await run('claude-code', 'session-start', { text: '<kinfold>pack</kinfold>', tokens: 5, updateNotice: NOTICE })) ?? '') as Record<string, any>
  expect(out.systemMessage).toBe('Kinfold 0.2.0 is available. Run `kinfold update`.')
  expect(out.hookSpecificOutput.additionalContext).toBe('<kinfold>pack</kinfold>')
  expect(out.hookSpecificOutput.additionalContext).not.toContain('is out')
})

test('Claude Code still gets the systemMessage when the pack is empty', async () => {
  const out = JSON.parse((await run('claude-code', 'session-start', { updateNotice: NOTICE })) ?? '') as Record<string, unknown>
  expect(out).toEqual({ systemMessage: 'Kinfold 0.2.0 is available. Run `kinfold update`.' })
})

test('Codex shows the notice to the user, like Claude Code; Cursor, with no user channel, gets the context alone: no notice reaches a model', async () => {
  const codex = JSON.parse((await run('codex', 'session-start', { text: '<kinfold>pack</kinfold>', tokens: 5, updateNotice: NOTICE })) ?? '') as Record<string, any>
  expect(codex.systemMessage).toBe('Kinfold 0.2.0 is available. Run `kinfold update`.')
  expect(codex.hookSpecificOutput.additionalContext).toBe('<kinfold>pack</kinfold>')
  const cursor = JSON.parse((await run('cursor', 'session-start', { text: '<kinfold>pack</kinfold>', tokens: 5, updateNotice: NOTICE })) ?? '') as Record<string, string>
  expect(cursor.additional_context).toBe('<kinfold>pack</kinfold>')
  const alone = JSON.parse((await run('codex', 'session-start', { updateNotice: NOTICE })) ?? '') as Record<string, unknown>
  expect(alone).toEqual({ systemMessage: 'Kinfold 0.2.0 is available. Run `kinfold update`.' })
  expect(await run('cursor', 'session-start', { updateNotice: NOTICE })).toBeNull()
})

test('no notice on prompt deltas', async () => {
  const out = await run('claude-code', 'user-prompt-submit', { text: '<kinfold>delta</kinfold>', tokens: 3, updateNotice: NOTICE })
  expect(asked[0]?.channel).toBe('prompt')
  expect(out).not.toContain('Kinfold 0.2.0')
  expect(out).not.toContain('systemMessage')
})

test('an update that installed itself reaches the user through Claude Code and Codex, and never the model elsewhere', async () => {
  const updated = { kind: 'updated', version: '0.2.1', previous: '0.2.0', channel: 'curl' } as const
  const claude = JSON.parse((await run('claude-code', 'session-start', { selfNotice: updated })) ?? '') as Record<string, any>
  expect(claude.systemMessage).toBe('Kinfold updated itself to 0.2.1 (was 0.2.0).')
  const codex = JSON.parse((await run('codex', 'session-start', { selfNotice: updated })) ?? '') as Record<string, any>
  expect(codex).toEqual({ systemMessage: 'Kinfold updated itself to 0.2.1 (was 0.2.0).' })
  expect(await run('cursor', 'session-start', { selfNotice: updated })).toBeNull()
})

test('a notice of a kind this hook does not know is dropped, and the pack still arrives', async () => {
  const out = JSON.parse((await run('claude-code', 'session-start', { text: '<kinfold>pack</kinfold>', tokens: 5, selfNotice: { kind: 'rolled-back', version: '0.2.1', channel: 'curl' } as never })) ?? '') as Record<string, any>
  expect(out.systemMessage).toBeUndefined()
  expect(out.hookSpecificOutput.additionalContext).toBe('<kinfold>pack</kinfold>')
})

test('an offer reaches the user and never a model, wherever the host shows it', async () => {
  const offer = { kind: 'offer', version: '0.6.0', channel: 'curl', changes: 3, breaking: 1 } as const
  const claude = JSON.parse((await run('claude-code', 'session-start', { text: '<kinfold>pack</kinfold>', tokens: 5, selfNotice: offer })) ?? '') as Record<string, any>
  expect(claude.systemMessage).toBe('Kinfold 0.6.0 is ready · 3 changes, 1 breaking · kinfold update to install')
  expect(claude.hookSpecificOutput.additionalContext).toBe('<kinfold>pack</kinfold>')
  const cursor = JSON.parse((await run('cursor', 'session-start', { text: '<kinfold>pack</kinfold>', tokens: 5, selfNotice: offer })) ?? '') as Record<string, string>
  expect(JSON.stringify(cursor)).not.toContain('0.6.0')
})

