import { expect, test } from 'bun:test'
import { MAX_CONTEXT_PROMPT_CHARS, parseContextRequest, parseContextResult } from './types'

const base = { host: 'claude-code', cwd: '/work/repo', hostSessionId: 's1' }

test('a prompt rides on the prompt channel only, as a string within the cap', () => {
  expect(parseContextRequest({ ...base, channel: 'prompt', prompt: 'fix csv' })).toEqual({ ok: true, value: { ...base, channel: 'prompt', prompt: 'fix csv' } })
  expect(parseContextRequest({ ...base, channel: 'prompt' })).toEqual({ ok: true, value: { ...base, channel: 'prompt' } })
  expect(parseContextRequest({ ...base, channel: 'session_start', prompt: 'x' }).ok).toBe(false)
  expect(parseContextRequest({ ...base, channel: 'prompt', prompt: 7 }).ok).toBe(false)
  expect(parseContextRequest({ ...base, channel: 'prompt', prompt: 'x'.repeat(MAX_CONTEXT_PROMPT_CHARS + 1) }).ok).toBe(false)
})

test('a refusal never echoes the prompt', () => {
  const refused = parseContextRequest({ ...base, channel: 'prompt', prompt: `SECRET-WORDS${'x'.repeat(MAX_CONTEXT_PROMPT_CHARS)}` })
  expect(refused.ok).toBe(false)
  expect(JSON.stringify(refused)).not.toContain('SECRET-WORDS')
})

test('a result may carry its related block only as the end of its text', () => {
  const base = { text: 'delta\nrelated', observationIds: [1, 2], tokens: 3 }
  expect(parseContextResult({ ...base, relatedText: 'related' })).toEqual({ ...base, relatedText: 'related' })
  expect(parseContextResult(base)).toEqual(base)
  for (const relatedText of ['', 'delta', 7]) expect(parseContextResult({ ...base, relatedText })).toBeNull()
})
