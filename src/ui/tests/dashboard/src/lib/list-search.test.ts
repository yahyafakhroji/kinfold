import { expect, test } from 'bun:test'
import { apiParams, parseListSearch, withFilter } from '../../../../dashboard/src/lib/list-search'

test('the URL gives back the list it describes, and drops what it cannot be', () => {
  expect(parseListSearch({ page: '3', sort: 'prompts', dir: 'asc', q: ' bun ', open: '12' })).toEqual({ page: 3, sort: 'prompts', dir: 'asc', q: 'bun', open: 12 })
  expect(parseListSearch({ page: '0', dir: 'up', open: '-1', q: '', host: 'x'.repeat(600) })).toEqual({})
  expect(parseListSearch({ page: 1 })).toEqual({})
})

test('the open row is not sent to the daemon, and a filter change starts again at page 1', () => {
  expect(apiParams({ page: 2, open: 5, q: 'x' })).toEqual({ page: 2, q: 'x' })
  expect(withFilter({ page: 4, q: 'old', host: 'codex' }, { q: '' })).toEqual({ host: 'codex' })
  expect(withFilter({ page: 4 }, { sort: 'agent', dir: 'asc' })).toEqual({ sort: 'agent', dir: 'asc' })
})
