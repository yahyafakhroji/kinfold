import { expect, test } from 'bun:test'
import { finalStrength, toSourceEvent } from './sources'
import type { ObserverEvent, ParsedObservation } from './types'

function stored(id: string, kind: string, tool?: Record<string, unknown>, withheld: string | null = null): ObserverEvent {
  return {
    eventId: id,
    sessionId: 1,
    promptNumber: 1,
    kind,
    toolName: typeof tool?.name === 'string' ? tool.name : null,
    payload: JSON.stringify({ kind, ...(tool !== undefined ? { tool } : {}) }),
    withheld,
    occurredAt: 1,
  }
}

const BATCH: ObserverEvent[] = [
  stored('prompt', 'user_prompt'),
  stored('output', 'tool_result', { name: 'Bash', output: '98 pass', exitCode: 0 }),
  stored('clean-empty', 'tool_result', { name: 'Bash', output: '', exitCode: 0 }),
  stored('failed-empty', 'tool_result', { name: 'Bash', output: '', exitCode: 1 }),
  stored('withheld', 'tool_result', { name: 'Read', output: '<withheld reason="sensitive_path" lines="3" chars="90"/>', withheld: 'sensitive_path' }, 'sensitive_path'),
  stored('start', 'session_start'),
  stored('turn', 'turn_end'),
  stored('failed-no-exit', 'tool_result', { name: 'Read', output: '', isError: true }),
  stored('failed-exit-2', 'tool_result', { name: 'Bash', output: '', exitCode: 2, isError: true }),
]

function proposed(strength: ParsedObservation['evidence']['strength'], ids: string[]): ParsedObservation {
  return { type: 'discovery', title: 't', narrative: '', facts: [], files: [], evidence: { strength, sourceEventIds: ids }, relations: [] }
}

test.each([
  ['tool-verified', ['output'], 'tool-verified'],
  ['tool-verified', ['clean-empty'], 'interpretation'],
  ['tool-verified', ['failed-empty'], 'tool-verified'],
  ['tool-verified', ['failed-no-exit'], 'tool-verified'],
  ['tool-verified', ['withheld'], 'interpretation'],
  ['tool-verified', ['prompt', 'turn'], 'interpretation'],
  ['tool-verified', ['start'], 'interpretation'],
  ['user-stated', ['prompt'], 'user-stated'],
  ['user-stated', ['output'], 'interpretation'],
  ['interpretation', ['output'], 'interpretation'],
] as const)('proposed %s citing %p is stored as %s', (strength, ids, expected) => {
  expect(finalStrength(proposed(strength, [...ids]), BATCH)).toBe(expected)
})

test('the source event carries the stored output length, exit code and withheld flag', () => {
  expect(toSourceEvent(BATCH[1]!)).toEqual({ eventId: 'output', kind: 'tool_result', tool: { name: 'Bash', outputChars: 7, exitCode: 0 } })
  expect(toSourceEvent(BATCH[4]!)?.tool).toMatchObject({ withheld: true, outputChars: 56 })
  expect(toSourceEvent(BATCH[5]!)).toBeNull()
})

test('isError without an exit code counts as exit 1, and a stored exit code wins', () => {
  expect(toSourceEvent(BATCH[7]!)?.tool?.exitCode).toBe(1)
  expect(toSourceEvent(BATCH[8]!)?.tool?.exitCode).toBe(2)
  expect(toSourceEvent(BATCH[2]!)?.tool?.exitCode).toBe(0)
})
