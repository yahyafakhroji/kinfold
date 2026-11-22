import { expect, test } from 'bun:test'
import { PURGE_TABLES } from '../../../../store/purge-store'
import { COUNT_NAMES, describeCounts } from './purge'

test('purge counts read in plain words', () => {
  expect(describeCounts({ observations: 1, links: 2, events: 0 })).toBe('1 memory, 2 links between memories')
  expect(describeCounts({ events: 0 })).toBe('nothing')
})

test('every table the daemon counts has a name', () => {
  expect([...PURGE_TABLES, 'findings', 'injectionsTrimmed', 'links'].filter((table) => COUNT_NAMES[table] === undefined)).toEqual([])
})
