import { expect, test } from 'bun:test'
import { createDashboardEvents, notableEvent } from './events'

test('a settings change, a backup or a restore that succeeded gets its own line after the request', () => {
  const events = createDashboardEvents(() => 5)
  const start = events.after(null)
  events.request('PUT', '/observer/settings', 200, 3)
  events.request('PUT', '/observer/settings', 400, 1)
  const { events: lines } = events.after(start.cursor, start.epoch)
  expect(lines.map((line) => (line.kind === 'event' ? line.text : `${line.method} ${line.path} ${line.status}`))).toEqual([
    'PUT /observer/settings 200', 'observer settings changed', 'PUT /observer/settings 400',
  ])
  expect(notableEvent('GET', '/backup', 200)).toBe('backup downloaded')
  expect(notableEvent('POST', '/restore', 202)).toBe('restore started')
  expect(notableEvent('GET', '/observer/settings', 200)).toBeNull()
  expect(notableEvent('PUT', '/observer/claude-token', 200)).toBe('claude-cli token saved')
  expect(notableEvent('DELETE', '/observer/claude-token', 200)).toBe('claude-cli token removed')
})

test('the newest entries are kept', () => {
  const events = createDashboardEvents(() => 1, 3)
  for (const text of ['a', 'b', 'c', 'd']) events.note(text)
  expect(events.after(0, events.after(null).epoch).events.map((line) => (line.kind === 'event' ? line.text : ''))).toEqual(['b', 'c', 'd'])
  const { epoch } = events.after(null)
  expect(events.after(4, epoch)).toEqual({ epoch, cursor: 4, events: [] })
  expect(events.after(2, epoch).events).toHaveLength(2)
})

test('a cursor from another daemon process reads every kept entry, even when the new daemon has logged more than the old cursor', () => {
  const before = createDashboardEvents(() => 1)
  before.note('old')
  const old = before.after(0)
  const after = createDashboardEvents(() => 1)
  for (const text of ['a', 'b', 'c']) after.note(text)
  expect(after.after(old.cursor, old.epoch).events.map((line) => (line.kind === 'event' ? line.text : ''))).toEqual(['a', 'b', 'c'])
  expect(after.after(old.cursor, null).events).toHaveLength(3)
  expect(after.after(null).epoch).not.toBe(old.epoch)
})
