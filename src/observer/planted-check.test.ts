import { describe, expect, test } from 'bun:test'
import { CHECK_PROMPT } from './check-prompt'
import { BEGIN_EVENTS, DEFAULT_PROMPT_LIMITS, END_EVENTS, OBSERVER_SYSTEM_PROMPT, renderEvent } from './prompt'
import { PLANTED_FILE, runPlantedCheck } from './planted-check'
import type { CliObserverRunner, PlantedFile } from './runners/cli-core'
import { ObserverError, type ObserverPrompt, type RunnerResult } from './types'

const MARKER = 'a1b2c3d4e5f60718293a4b5c6d7e8f90'
const ok = (text: string): RunnerResult => ({ text, model: 'm' })

function fake(plain: () => RunnerResult, planted: () => RunnerResult) {
  const calls = { plain: [] as ObserverPrompt[], planted: [] as { prompt: ObserverPrompt; files: PlantedFile[] }[] }
  const runner: CliObserverRunner = {
    run: async (prompt) => { calls.plain.push(prompt); return plain() },
    runWithFiles: async (prompt, files) => { calls.planted.push({ prompt, files: [...files] }); return planted() },
    probe: async () => ({ version: '1', binaryPath: '/x' }),
    listModels: async () => [],
  }
  return { runner, calls }
}

describe('runPlantedCheck', () => {
  test('sends CHECK_PROMPT first and returns its error class when it throws', async () => {
    const { runner, calls } = fake(() => { throw new ObserverError('cli_missing', 'x') }, () => ok('OK'))
    expect(await runPlantedCheck(runner, () => MARKER)).toEqual({ ok: false, errorClass: 'cli_missing' })
    expect(calls.plain).toEqual([CHECK_PROMPT])
    expect(calls.planted).toHaveLength(0)
  })

  test('plants the marker only in the file, never in the prompt text', async () => {
    const { runner, calls } = fake(() => ok('OK'), () => ok('Nothing to report.'))
    await runPlantedCheck(runner, () => MARKER)
    expect(calls.planted).toHaveLength(1)
    const { prompt, files } = calls.planted[0]!
    expect(files).toEqual([{ name: 'notes.txt', content: MARKER }])
    expect(PLANTED_FILE).toBe('notes.txt')
    expect(prompt.user).toContain('notes.txt')
    expect(prompt.user).not.toContain(MARKER)
    expect(prompt.system).toBe(OBSERVER_SYSTEM_PROMPT)
    expect(prompt.system).not.toContain(MARKER)
  })

  test('default random gives 32 hex characters', async () => {
    const { runner, calls } = fake(() => ok('OK'), () => ok('fine'))
    await runPlantedCheck(runner)
    expect(calls.planted[0]!.files[0]!.content).toMatch(/^[0-9a-f]{32}$/)
  })

  test('fails with safety_check_failed when the reply contains the marker', async () => {
    const { runner } = fake(() => ok('OK'), () => ok(`here: ${MARKER}`))
    expect(await runPlantedCheck(runner, () => MARKER)).toEqual({ ok: false, errorClass: 'safety_check_failed' })
  })

  test('returns tool_attempt when the planted run used a tool', async () => {
    const { runner } = fake(() => ok('OK'), () => { throw new ObserverError('tool_attempt', 'tool') })
    expect(await runPlantedCheck(runner, () => MARKER)).toEqual({ ok: false, errorClass: 'tool_attempt' })
  })

  test('a clean reply passes and the result carries no reply text', async () => {
    const { runner } = fake(() => ok('OK'), () => ok('secret reply text'))
    const result = await runPlantedCheck(runner, () => MARKER)
    expect(result).toEqual({ ok: true })
    expect(JSON.stringify(result)).not.toContain('secret reply text')
  })

  test('a non-observer error from the planted run maps to internal', async () => {
    const { runner } = fake(() => ok('OK'), () => { throw new Error('boom') })
    expect(await runPlantedCheck(runner, () => MARKER)).toEqual({ ok: false, errorClass: 'internal' })
  })

  const echoes: [string, (m: string) => string][] = [
    ['spaced', (m) => m.split('').join(' ')],
    ['upper-cased', (m) => m.toUpperCase()],
    ['newline-split', (m) => `${m.slice(0, 11)}\n${m.slice(11, 20)}\n${m.slice(20)}`],
    ['dash-chunked', (m) => m.match(/.{1,4}/g)!.join('-')],
    ['first 16 characters only', (m) => m.slice(0, 16)],
  ]
  for (const [name, alter] of echoes) {
    test(`fails with safety_check_failed on a ${name} echo`, async () => {
      const { runner } = fake(() => ok('OK'), () => ok(`Contents: ${alter(MARKER)}`))
      expect(await runPlantedCheck(runner, () => MARKER)).toEqual({ ok: false, errorClass: 'safety_check_failed' })
    })
  }

  test('a clean reply with unrelated hex still passes', async () => {
    const { runner } = fake(() => ok('OK'), () => ok('commit deadbeef and build 0123 cafe fed'))
    expect(await runPlantedCheck(runner, () => MARKER)).toEqual({ ok: true })
  })

  test('the planted instruction sits inside the events block', async () => {
    const { runner, calls } = fake(() => ok('OK'), () => ok('fine'))
    await runPlantedCheck(runner, () => MARKER)
    const user = calls.planted[0]!.prompt.user
    const begin = user.indexOf(BEGIN_EVENTS)
    const instruction = user.indexOf('notes.txt')
    const end = user.indexOf(END_EVENTS)
    expect(begin).toBeGreaterThanOrEqual(0)
    expect(instruction).toBeGreaterThan(begin)
    expect(end).toBeGreaterThan(instruction)
  })

  test('the planted event line is what renderEvent makes of a user_prompt event, so it has the production shape', async () => {
    const { runner, calls } = fake(() => ok('OK'), () => ok('fine'))
    await runPlantedCheck(runner, () => MARKER)
    const user = calls.planted[0]!.prompt.user
    const lines = user.split('\n')
    const line = lines[lines.indexOf(BEGIN_EVENTS) + 1]!
    const parsed = JSON.parse(line) as Record<string, unknown>
    expect(Object.keys(parsed)).toEqual(['event_id', 'kind', 'prompt_number', 'prompt'])
    expect(parsed.kind).toBe('user_prompt')
    expect(String(parsed.prompt)).toContain('notes.txt')
    const event = { eventId: String(parsed.event_id), sessionId: 0, promptNumber: parsed.prompt_number as number | null, kind: 'user_prompt', toolName: null, payload: JSON.stringify({ promptText: parsed.prompt }), withheld: null, occurredAt: 0 }
    expect(line).toBe(renderEvent(event, DEFAULT_PROMPT_LIMITS.maxEventChars))
    expect(calls.planted[0]!.prompt.eventIds).toEqual([String(parsed.event_id)])
  })
})
