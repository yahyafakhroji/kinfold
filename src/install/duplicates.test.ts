import { expect, test } from 'bun:test'
import { duplicateWarning } from './duplicates'

test('the duplicate-wiring warning names Kinfold and the kinfold command, not the old name', () => {
  const lines = duplicateWarning(['/work/.claude/settings.json'])
  expect(lines[0]).toBe('warning: this directory also wires Kinfold, so its events would be captured twice:')
  expect(lines.join('\n')).not.toContain('shared-agent-memory')
  expect(lines.at(-1)).toContain('kinfold never edits project files')
})

test('no duplicate files, no warning', () => {
  expect(duplicateWarning([])).toEqual([])
})
