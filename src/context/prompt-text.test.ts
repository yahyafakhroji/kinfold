import { expect, test } from 'bun:test'
import { promptForRecall, searchablePrompt, splitPrompt } from './prompt-text'

const PASTED = 'Claude pasted this <pasted_content id="bb24">\nthe sqlite3mc build log\n</pasted_content id="bb24"> fix it'

test('pasted content tags and their ids are stripped; the paste is kept apart from the user\'s own words', () => {
  expect(splitPrompt(PASTED)).toEqual({ own: 'Claude pasted this fix it', pasted: ['the sqlite3mc build log'] })
})

test('a paste cut off before its closing tag is still a paste', () => {
  expect(splitPrompt('look at <pasted_content id="9f">first lines of a long')).toEqual({ own: 'look at', pasted: ['first lines of a long'] })
  expect(splitPrompt('look at <pasted_content>a plain closing</pasted_content> now')).toEqual({ own: 'look at now', pasted: ['a plain closing'] })
})

test('blocks an agent adds are dropped whole; command arguments stay as the user\'s words', () => {
  const text = '<system-reminder>internal rules here</system-reminder>\n<command-name>/review</command-name><command-message>review</command-message>'
    + '<command-args>the parser change</command-args><local-command-stdout>noise output</local-command-stdout> please'
  expect(splitPrompt(text)).toEqual({ own: 'the parser change please', pasted: [] })
})

test('the searchable text holds no wrapper and no id', () => {
  const text = searchablePrompt(PASTED)
  expect(text).toBe('Claude pasted this fix it\nthe sqlite3mc build log')
  expect(text).not.toContain('pasted_content')
  expect(text).not.toContain('bb24')
})

test('the hook\'s form puts the user\'s words before the paste, so a cut keeps them', () => {
  const long = `<pasted_content id="aa11">${'x '.repeat(3_000)}</pasted_content id="aa11"> why does the build fail`
  const recall = promptForRecall(long).slice(0, 2_000)
  expect(recall.startsWith('why does the build fail')).toBe(true)
  expect(splitPrompt(recall).own).toBe('why does the build fail')
  expect(recall).not.toContain('aa11')
})

test('a prompt with no wrappers passes through as typed', () => {
  expect(promptForRecall('how do we pin bun in CI?')).toBe('how do we pin bun in CI?')
  expect(splitPrompt('how do we pin bun in CI?')).toEqual({ own: 'how do we pin bun in CI?', pasted: [] })
})
