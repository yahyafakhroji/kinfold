import { expect, test } from 'bun:test'
import { logLine } from './log-line'

test('a log line starts with the UTC time, then the prefix and the message', () => {
  expect(logLine('drained read=1', new Date(Date.UTC(2026, 9, 30, 4, 5, 6, 789)))).toBe('2026-10-30T04:05:06.789Z sam-daemon: drained read=1\n')
})
