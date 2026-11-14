import { describe, expect, test } from 'bun:test'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { type EventKind, type NormalizedEvent, validateEvent } from '../../contract/event'
import { hookSpecFor } from '../hook-specs'
import type { AgentId } from '../profile'
import { normalizeGeminiStyle } from './gemini-style-parse'

const FIXTURES = join(import.meta.dir, '../../../test/fixtures')
const fixture = (host: string, file: string): Record<string, unknown> => JSON.parse(readFileSync(join(FIXTURES, host, file), 'utf8'))
const filesOf = (host: string): string[] => readdirSync(join(FIXTURES, host)).filter((file) => file.startsWith('docs-')).sort()

let counter = 0
const context = { now: () => 1_792_841_878_000, newId: () => `01JB${String(++counter).padStart(22, '0')}` }

function normalize(host: AgentId, payload: unknown): NormalizedEvent | null {
  const spec = hookSpecFor(host)
  if (spec === null) throw new Error(`${host} has no hook spec`)
  return spec.normalize(payload, context)
}

function expectSafe(host: AgentId, payloads: readonly unknown[]): void {
  for (const payload of payloads) {
    let event: NormalizedEvent | null = null
    expect(() => {
      event = normalize(host, payload)
    }).not.toThrow()
    expect(event).toBeNull()
  }
}

const GEMINI_KIND: Readonly<Record<string, EventKind>> = {
  'session-start': 'session_start',
  'before-agent': 'user_prompt',
  'after-tool': 'tool_result',
  'after-tool-error': 'tool_result',
  'after-agent': 'turn_end',
  'session-end': 'session_end',
}

describe('gemini-cli', () => {
  test('gemini-cli: each fixture normalizes to the right kind with session, cwd and tool fields', () => {
    const files = filesOf('gemini-cli')
    expect(files.length).toBe(6)
    for (const file of files) {
      const raw = fixture('gemini-cli', file)
      const event = normalize('gemini-cli', raw)
      expect({ file, kind: event?.kind }).toEqual({ file, kind: GEMINI_KIND[file.replace(/^docs-constructed-/, '').replace(/\.json$/, '')] })
      if (event === null) continue
      expect(validateEvent(event).ok).toBe(true)
      expect(event).toMatchObject({ host: 'gemini-cli', hostSessionId: raw.session_id, cwd: raw.cwd, transcriptPath: raw.transcript_path })
      if (event.kind === 'tool_result') expect(event.tool).toMatchObject({ name: raw.tool_name, input: raw.tool_input })
    }
    expect(normalize('gemini-cli', fixture('gemini-cli', 'docs-constructed-before-agent.json'))).toMatchObject({ promptText: 'Add a test for the parser', isUserTurn: true })
    expect(normalize('gemini-cli', fixture('gemini-cli', 'docs-constructed-after-tool.json'))?.tool).toEqual({ name: 'read_file', input: { absolute_path: '/Users/me/project/README.md' }, output: '# Project' })
    expect(normalize('gemini-cli', fixture('gemini-cli', 'docs-constructed-after-tool-error.json'))?.tool).toMatchObject({ isError: true, output: 'Command failed' })
    expect(normalize('gemini-cli', fixture('gemini-cli', 'docs-constructed-after-agent.json'))).toMatchObject({ assistantText: 'Added the test.' })
  })

  test('gemini-cli: llmContent given as parts, or missing, still yields text', () => {
    const raw = fixture('gemini-cli', 'docs-constructed-after-tool.json')
    const parts = { ...raw, tool_response: { llmContent: [{ text: 'one' }, { text: 'two' }], returnDisplay: 'x' } }
    expect(normalize('gemini-cli', parts)?.tool?.output).toBe('one\ntwo')
    const displayOnly = { ...raw, tool_response: { returnDisplay: 'shown' } }
    expect(normalize('gemini-cli', displayOnly)?.tool?.output).toBe('shown')
    const none = { ...raw, tool_response: undefined }
    expect(normalize('gemini-cli', none)?.tool?.output).toBe('')
  })

  test('gemini-cli: a minimal payload with only hook_event_name returns an event with fallbacks or null and never throws', () => {
    expectSafe('gemini-cli', [
      ...['SessionStart', 'BeforeAgent', 'AfterTool', 'AfterAgent', 'SessionEnd'].map((name) => ({ hook_event_name: name })),
      'nope', null, 42, [],
      { hook_event_name: 'AfterTool', session_id: 's', cwd: '/p' },
      { hook_event_name: 'SessionStart', session_id: 's', cwd: 'relative' },
      { hook_event_name: 'BeforeTool', session_id: 's', cwd: '/p' },
    ])
  })
})

describe('antigravity', () => {
  test('antigravity: each fixture normalizes to the right kind with session, cwd and tool fields', () => {
    const expected: Readonly<Record<string, EventKind | undefined>> = {
      'docs-session-start.json': 'session_start',
      'docs-constructed-pre-invocation.json': 'user_prompt',
      'docs-constructed-pre-invocation-later.json': undefined,
      'docs-constructed-post-tool-use.json': 'tool_result',
      'docs-constructed-post-tool-use-error.json': 'tool_result',
      'docs-constructed-stop.json': 'turn_end',
    }
    expect(filesOf('antigravity')).toEqual(Object.keys(expected).sort())
    for (const file of filesOf('antigravity')) {
      const raw = fixture('antigravity', file)
      const event = normalize('antigravity', raw)
      expect({ file, kind: event?.kind }).toEqual({ file, kind: expected[file] })
      if (event === null) continue
      expect(validateEvent(event).ok).toBe(true)
      expect(event).toMatchObject({ host: 'antigravity', hostSessionId: raw.conversationId, cwd: '/workspace/project' })
    }
    expect(normalize('antigravity', fixture('antigravity', 'docs-constructed-pre-invocation.json'))).toMatchObject({ promptText: 'Add a test for the parser', isUserTurn: true })
    expect(normalize('antigravity', fixture('antigravity', 'docs-constructed-post-tool-use.json'))?.tool).toEqual({ name: 'run_command', input: { CommandLine: 'bun test' }, output: '' })
    expect(normalize('antigravity', fixture('antigravity', 'docs-constructed-post-tool-use-error.json'))?.tool).toMatchObject({ name: 'view_file', isError: true, output: 'file not found' })
  })

  test('antigravity: a transcript path given with ~ is left out, an absolute one is kept', () => {
    expect(normalize('antigravity', fixture('antigravity', 'docs-session-start.json'))?.transcriptPath).toBeUndefined()
    expect(normalize('antigravity', fixture('antigravity', 'docs-constructed-stop.json'))?.transcriptPath).toEndWith('transcript.jsonl')
  })

  test('antigravity: a minimal payload returns an event with fallbacks or null and never throws', () => {
    expectSafe('antigravity', [
      {}, 'nope', null, 42, [],
      { conversationId: 'c' },
      { workspacePaths: ['/p'] },
      { conversationId: 'c', workspacePaths: ['relative'] },
      { conversationId: 'c', workspacePaths: [] },
      { conversationId: 'c', workspacePaths: ['/p'], toolCall: {}, stepIdx: 1 },
      { conversationId: 'c', workspacePaths: ['/p'], invocationNum: 2 },
    ])
  })
})

describe('normalizeGeminiStyle', () => {
  test('maps only the events in its table, and labels the event with the host it was built for', () => {
    const normalize = normalizeGeminiStyle({ Begin: 'session_start' }, 'gemini-cli')
    expect(normalize({ hook_event_name: 'Begin', session_id: 's', cwd: '/p' }, context)).toMatchObject({ kind: 'session_start', host: 'gemini-cli' })
    expect(normalize({ hook_event_name: 'SessionStart', session_id: 's', cwd: '/p' }, context)).toBeNull()
  })
})
