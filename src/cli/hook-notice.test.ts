import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ContextRequest, ContextResult } from '../context/types'
import { runHook } from './hook'

const FIXTURES = join(import.meta.dir, '../../test/fixtures')
const NOTICE = { version: '0.2.0', channel: 'curl' } as const
const AGENT_LINE = 'Kinfold 0.2.0 is out; you may tell the user they can run `kinfold update`.'

let root: string
let dataDir: string
let asked: ContextRequest[]
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'kinfold-hook-notice-'))
  dataDir = join(root, 'data')
  mkdirSync(dataDir, { recursive: true })
  writeFileSync(join(dataDir, 'daemon.json'), JSON.stringify({ pid: 1, port: 4 }))
  writeFileSync(join(dataDir, 'daemon.token'), 'a'.repeat(64))
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

test('Codex and Cursor get the agent line in the block', async () => {
  const codex = JSON.parse((await run('codex', 'session-start', { text: '<kinfold>pack</kinfold>', tokens: 5, updateNotice: NOTICE })) ?? '') as Record<string, any>
  expect(codex.systemMessage).toBeUndefined()
  expect(codex.hookSpecificOutput.additionalContext).toBe(`<kinfold>pack</kinfold>\n${AGENT_LINE}`)
  const cursor = JSON.parse((await run('cursor', 'session-start', { text: '<kinfold>pack</kinfold>', tokens: 5, updateNotice: NOTICE })) ?? '') as Record<string, string>
  expect(cursor.additional_context).toBe(`<kinfold>pack</kinfold>\n${AGENT_LINE}`)
  const alone = JSON.parse((await run('codex', 'session-start', { updateNotice: NOTICE })) ?? '') as Record<string, any>
  expect(alone.hookSpecificOutput.additionalContext).toBe(AGENT_LINE)
})

test('no notice on prompt deltas', async () => {
  const out = await run('claude-code', 'user-prompt-submit', { text: '<kinfold>delta</kinfold>', tokens: 3, updateNotice: NOTICE })
  expect(asked[0]?.channel).toBe('prompt')
  expect(out).not.toContain('Kinfold 0.2.0')
  expect(out).not.toContain('systemMessage')
})
