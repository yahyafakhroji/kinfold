import { expect, test } from 'bun:test'
import {
  DAEMON_DOWN_LINE,
  FIRST_SCREEN_ROWS,
  HELD_OUT_LINE,
  type FirstScreen,
  type Recalled,
  cleanTitle,
  firstScreenList,
  idsInLine,
  recallLine,
} from './recall-line'

const HOUR = 3_600_000
const NOW = 1_800_000_000_000

const related = (id: number, title: string): Recalled => ({ id, title, part: 'related' })
const fresh = (id: number, title: string): Recalled => ({ id, title, part: 'new' })

test('the line names what was recalled, in the order it was sent', () => {
  const recalled = [related(28771, 'Bun 1.4.4 is pinned'), related(94451, 'Schema version from MIGRATIONS'), related(28768, 'Service selection')]
  expect(recallLine([28771, 94451, 28768], recalled))
    .toBe('kinfold · recalled 3 · #28771 Bun 1.4.4 is pinned · #94451 Schema version from MIGRATIONS · #28768 Service selection')
})

test('nothing sent reads as nothing recalled', () => {
  expect(recallLine([], [])).toBe('kinfold · nothing recalled')
  // Titles for ids that were not sent are not a recall.
  expect(recallLine([], [related(1, 'never sent')])).toBe('kinfold · nothing recalled')
})

test('both kinds of prompt-time memory are counted and named', () => {
  expect(recallLine([5, 7, 9], [fresh(5, 'From another session'), related(7, 'A'), related(9, 'B')]))
    .toBe('kinfold · recalled 3 (2 related, 1 new from other sessions) · #5 From another session · #7 A · #9 B')
  expect(recallLine([5], [fresh(5, 'From another session')])).toBe('kinfold · recalled 1 (new from other sessions) · #5 From another session')
})

test('the line is built from the ids alone: a missing title shows the id, an extra title is dropped', () => {
  const line = recallLine([3, 4], [related(4, 'Known'), related(99, 'Not sent')])
  expect(line).toBe('kinfold · recalled 2 · #3 · #4 Known')
  expect(idsInLine(line)).toEqual([3, 4])
})

test('more than five are counted, not listed', () => {
  const ids = [1, 2, 3, 4, 5, 6, 7]
  const line = recallLine(ids, ids.map((id) => related(id, `t${id}`)))
  expect(line).toBe('kinfold · recalled 7 · #1 t1 · #2 t2 · #3 t3 · #4 t4 · #5 t5 · +2 more')
})

test('a hostile title stays one line and carries no control characters', () => {
  const title = `first line\nsecond \u001b[31mred\u001b[0m\u0007 ‮evil ${'x'.repeat(500)}`
  const line = recallLine([1], [related(1, title)])
  expect(line.includes('\n')).toBe(false)
  // No C0/C1 control, and no bidi override that could reorder the terminal line.
  expect(/[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]/.test(line)).toBe(false)
  expect(line.length).toBeLessThan(90)
  expect(line.endsWith('…')).toBe(true)
  expect(cleanTitle('  a \t b\r\nc  ')).toBe('a b c')
})

test('the fixed lines', () => {
  expect(HELD_OUT_LINE).toBe('kinfold · recall held out for this prompt (impact test)')
  expect(DAEMON_DOWN_LINE).toBe('kinfold · daemon not running; this prompt is saved and will be captured when it starts')
})

const screen = (rows: FirstScreen['rows'], extra: Partial<FirstScreen> = {}): FirstScreen => ({ project: 'shared-agent-memory', total: 1284, lastSessionAt: NOW - 2 * HOUR, rows, ...extra })

test('the first-screen list shows the newest memories the pack carried', () => {
  const rows = [
    { id: 95012, title: 'CI pins Bun with .bun-version', occurredAt: NOW - 2 * HOUR },
    { id: 94998, title: 'Backup archive holds snapshot + manifest', occurredAt: NOW - 26 * HOUR },
  ]
  const ids = [95012, 94998, 1, 2, 3, 4, 5]
  expect(firstScreenList(screen(rows), ids, NOW)).toBe([
    'kinfold · shared-agent-memory · 1,284 memories · last session 2h ago',
    '  #95012  CI pins Bun with .bun-version             (2h)',
    '  #94998  Backup archive holds snapshot + manifest  (1d)',
    "  … 5 more in this session's context · kinfold dashboard",
  ].join('\n'))
})

test('the list never shows more than eight rows, nor a memory the pack did not carry', () => {
  const rows = Array.from({ length: 12 }, (_, index) => ({ id: index + 1, title: `m${index + 1}`, occurredAt: NOW - index * HOUR }))
  const ids = rows.map((row) => row.id).filter((id) => id !== 3)
  const lines = firstScreenList(screen(rows), ids, NOW).split('\n')
  expect(FIRST_SCREEN_ROWS).toBe(8)
  expect(lines.length).toBe(1 + 8 + 1)
  expect(lines.some((line) => line.includes('#3 '))).toBe(false)
  expect(lines.at(-1)).toBe("  … 3 more in this session's context · kinfold dashboard")
})

test('a project with no memory, a first session, and an agent that takes no pack', () => {
  expect(firstScreenList(screen([], { total: 0, lastSessionAt: null }), [], NOW)).toBe('kinfold · shared-agent-memory · no memories yet')
  expect(firstScreenList(screen([{ id: 1, title: 'only', occurredAt: NOW - 60_000 }], { total: 1, lastSessionAt: null }), [1], NOW))
    .toBe('kinfold · shared-agent-memory · 1 memory\n  #1  only  (1m)')
  expect(firstScreenList(screen([]), [], NOW, { takesPack: false }))
    .toBe('kinfold · shared-agent-memory · 1,284 memories · last session 2h ago\n  no memory is sent at session start on this agent · kinfold dashboard')
})

test('an answer with no header still says how much was sent', () => {
  expect(firstScreenList(null, [4, 5, 6], NOW)).toBe("kinfold · 3 memories in this session's context · kinfold dashboard")
  expect(firstScreenList(null, [], NOW)).toBe('kinfold · no memories yet')
})
