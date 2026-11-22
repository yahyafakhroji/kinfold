import { describe, expect, test } from 'bun:test'
import { resolveEvidenceStrength, type SourceEvent } from './evidence'

const toolResult = (exitCode: number | undefined, outputChars: number): SourceEvent => ({
  eventId: `tool-${exitCode}-${outputChars}`,
  kind: 'tool_result',
  tool: { name: 'Bash', exitCode, outputChars },
})
const userPrompt: SourceEvent = { eventId: 'prompt-1', kind: 'user_prompt' }
const turnEnd: SourceEvent = { eventId: 'turn-1', kind: 'turn_end' }

describe('resolveEvidenceStrength', () => {
  test('keeps tool-verified when a cited tool result has output', () => {
    expect(resolveEvidenceStrength({ strength: 'tool-verified', sourceEventIds: [] }, [toolResult(0, 812)]))
      .toBe('tool-verified')
  })

  test('keeps tool-verified for a failed command even with empty output', () => {
    expect(resolveEvidenceStrength({ strength: 'tool-verified', sourceEventIds: [] }, [toolResult(1, 0)]))
      .toBe('tool-verified')
  })

  test('downgrades a clean exit with empty output (the #68616 case)', () => {
    expect(resolveEvidenceStrength({ strength: 'tool-verified', sourceEventIds: [] }, [toolResult(0, 0)]))
      .toBe('interpretation')
  })

  test('downgrades a claim backed only by a withheld output', () => {
    const withheld: SourceEvent = { eventId: 'env-read', kind: 'tool_result', tool: { name: 'Read', outputChars: 52, withheld: true } }
    expect(resolveEvidenceStrength({ strength: 'tool-verified', sourceEventIds: [] }, [withheld]))
      .toBe('interpretation')
  })

  test('downgrades tool-verified that cites no tool result', () => {
    expect(resolveEvidenceStrength({ strength: 'tool-verified', sourceEventIds: [] }, [userPrompt, turnEnd]))
      .toBe('interpretation')
    expect(resolveEvidenceStrength({ strength: 'tool-verified', sourceEventIds: [] }, []))
      .toBe('interpretation')
  })

  test('keeps user-stated only when a user prompt is cited', () => {
    expect(resolveEvidenceStrength({ strength: 'user-stated', sourceEventIds: [] }, [userPrompt]))
      .toBe('user-stated')
    expect(resolveEvidenceStrength({ strength: 'user-stated', sourceEventIds: [] }, [toolResult(0, 50)]))
      .toBe('interpretation')
  })

  test('leaves interpretation as interpretation', () => {
    expect(resolveEvidenceStrength({ strength: 'interpretation', sourceEventIds: [] }, [toolResult(0, 50)]))
      .toBe('interpretation')
  })
})
