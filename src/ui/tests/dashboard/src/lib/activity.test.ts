import { expect, test } from 'bun:test'
import { PROBLEMS, activitySentence } from '../../../../dashboard/src/lib/activity'
import { OBSERVER_ERROR_CLASSES } from '../../../../../resources/observer/types'
import type { ActivityRow } from '../../../../dashboard/src/lib/types'

const row = (change: Partial<ActivityRow>): ActivityRow => ({ id: 1, at: 1, kind: 'recall', host: 'claude-code', projectKey: 'k', project: 'kinfold', sessionId: 1, device: null, count: 3, detail: null, ...change })

test('each kind reads as a sentence', () => {
  expect(activitySentence(row({}))).toBe('Claude Code in kinfold was given 3 memories')
  expect(activitySentence(row({ kind: 'save', host: 'opencode', count: 1 }))).toBe('OpenCode in kinfold: 1 new memory saved')
  expect(activitySentence(row({ kind: 'observer-failed', detail: 'timeout' }))).toBe('Summaries for Claude Code in kinfold failed: the model took too long to answer')
  expect(activitySentence(row({ kind: 'observer-failed', detail: 'something-new' }))).toBe('Summaries for Claude Code in kinfold failed: something unexpected went wrong')
  expect(activitySentence(row({ kind: 'restore', detail: 'undo', host: null, project: null }))).toBe('Kinfold switched back to the memory a restore replaced')
  expect(activitySentence(row({ kind: 'device-paired', device: 'dev-a' }), new Map([['dev-a', 'MacBook Air']]))).toBe('MacBook Air joined as a device')
  expect(activitySentence(row({ kind: 'update-installed', detail: '0.6.1' }))).toBe('Kinfold 0.6.1 was installed')
})

test('every error class the daemon knows has words', () => {
  expect([...OBSERVER_ERROR_CLASSES, 'other'].filter((name) => PROBLEMS[name] === undefined)).toEqual([])
})
