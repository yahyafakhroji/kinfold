import { expect, test } from 'bun:test'
import type { Measured, Overview } from '../../../../dashboard/src/lib/types'
import { weekSentence, worthALook } from '../../../../dashboard/src/pages/overview'

const overview = (change: Partial<Overview> = {}): Overview => ({
  memories: 294, projects: 3, sessions: 60, week: { sessions: 20, prompts: 42, promptsWithMemory: 37 },
  saved: { measured: { tokens: 182_000, sessions: 12 }, estimate: { tokens: 3_000, sessions: 4, partial: false } }, failing: [], recordsSince: 1, ...change,
})
const result = (status: 'saving' | 'cost' | 'no-difference'): [string, Measured][] => [['claude-code', { status, perTurn: status === 'cost' ? -900 : 2_000, low: 1, high: 2, heldOut: 40, normal: 372 }]]

test('the week follows the measured result, including when it found no saving or a cost', () => {
  expect(weekSentence(overview(), result('saving'))).toBe('This week your agents used memory on 37 of 42 prompts. It saved about 182,000 tokens, measured from 412 of your turns.')
  expect(weekSentence(overview(), result('no-difference'))).toBe('This week your agents used memory on 37 of 42 prompts. No measurable saving yet (412 turns compared; the difference is within normal variation). Memory still brings back past decisions, so agents ask you less.')
  expect(weekSentence(overview(), result('cost'))).toContain('memory has cost more tokens than it saved so far (412 turns compared)')
  // No measured result at all: the estimate, said to be one.
  expect(weekSentence(overview({ saved: { measured: { tokens: 0, sessions: 0 }, estimate: { tokens: 3_000, sessions: 4, partial: false } } }), [])).toContain('saved up to about 3,000 tokens (an estimate')
  expect(weekSentence(overview({ week: { sessions: 0, prompts: 0, promptsWithMemory: 0 } }), [])).toContain('No prompts this week yet')
})

test('worth a look names what needs the reader, most pressing first', () => {
  const now = 100 * 86_400_000
  const looks = worthALook({
    overview: overview({ failing: [{ host: 'codex', provider: 'codex-cli', errorClass: 'timeout', at: now }] }),
    central: { role: 'device', hub: 'mac-mini', address: 'x', deviceId: 'dev-a', reachable: false, problem: null, queued: 3, lastContactAt: null },
    update: { notice: null, install: null, release: { version: '0.7.0', changes: [], breaking: [], staged: true, installable: true } },
    lastBackupAt: now - 10 * 86_400_000,
    now,
  })
  expect(looks.map((look) => look.tone)).toEqual(['bad', 'bad', 'warn'])
  // A device keeps no backup of its own: the hub does.
  expect(worthALook({ overview: overview(), central: { role: 'local' }, update: undefined, lastBackupAt: null, now }).length).toBe(1)
})
