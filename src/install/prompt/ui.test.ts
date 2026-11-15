import { afterEach, expect, test } from 'bun:test'
import { type FakeWorld, createWorld } from '../test-support'
import { fakeTerminal } from './fake-terminal'
import { createPrompts } from './prompts'
import { uiFor } from './ui'

let world: FakeWorld | null = null
afterEach(async () => {
  await world?.cleanup()
  world = null
})

test('without a terminal the run is plain and has no questions', async () => {
  world = createWorld({ terminal: null })
  const ui = await uiFor(world.env, { yes: false })
  expect(ui.framed).toBe(false)
  expect(ui.prompts).toBeNull()
  ui.output.say('a line')
  expect(world.out).toEqual(['a line'])
})

test('--yes is plain even on a terminal: a child install must never draw or wait', async () => {
  const term = fakeTerminal([])
  world = createWorld({ terminal: term, interactive: true })
  const ui = await uiFor(world.env, { yes: true })
  expect(ui.framed).toBe(false)
  expect(ui.prompts).toBeNull()
  ui.output.say('a line')
  expect(world.out).toEqual(['a line'])
  expect(term.output()).toBe('')
})

test('a terminal without --yes is framed, and its output is its prompts', async () => {
  const term = fakeTerminal([])
  world = createWorld({ terminal: term, interactive: true })
  world.env = { ...world.env, promptsFor: createPrompts }
  const ui = await uiFor(world.env, { yes: false })
  expect(ui.framed).toBe(true)
  expect(ui.prompts).not.toBeNull()
  expect(ui.output).toBe(ui.prompts as NonNullable<typeof ui.prompts>)
  ui.output.say('a line')
  expect(world.out).toEqual([])
  expect(term.output()).toContain('a line')
})

// ---- paths under the home -------------------------------------------------------

const visible = (term: ReturnType<typeof fakeTerminal>): string => term.output().replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '')

test('the framed renderer draws a path under the home as ~, wherever it draws one', async () => {
  const term = fakeTerminal(['\r', '\r'])
  world = createWorld({ terminal: term, interactive: true })
  const home = world.home
  const ui = await uiFor(world.env, { yes: false })
  const out = ui.output
  out.intro(`setup in ${home}`)
  out.say(`data dir ${home}/.kinfold: modes ok`)
  out.warn(`left ${home}/.zshrc alone`)
  out.error(`cannot write ${home}/.kinfold/install.json`)
  out.section(`Files in ${home}`, [{ mark: 'ok', text: `claude-code: yes in ${home}/.claude.json` }, { mark: 'none', text: `home is ${home}` }])
  const bar = out.progress(1)
  bar.step(`writing ${home}/.zshrc`)
  bar.note(`  1. write ${home}/.zshrc`)
  bar.done(`log in ${home}/.kinfold/logs/install.log`)
  const busy = out.busy(`copying to ${home}/a.kinfold`)
  busy.note(`from ${home}/.kinfold`)
  busy.done(`backup written: ${home}/a.kinfold`)
  await ui.prompts?.confirm(`Add ${home}/.local/bin to PATH?`, true)
  expect(await ui.prompts?.text(`Folder (${home}):`, `${home}/.kinfold`)).toBe(`${home}/.kinfold`)
  out.outro(`see ${home}/.kinfold`)
  const text = visible(term)
  expect(text).not.toContain(home)
  for (const expected of ['setup in ~', 'data dir ~/.kinfold: modes ok', 'left ~/.zshrc alone', 'cannot write ~/.kinfold/install.json', 'Files in ~', 'claude-code: yes in ~/.claude.json', 'home is ~', 'writing ~/.zshrc', '1. write ~/.zshrc', 'log in ~/.kinfold/logs/install.log', 'copying to ~/a.kinfold', 'from ~/.kinfold', 'backup written: ~/a.kinfold', 'Add ~/.local/bin to PATH?', 'Folder (~):', 'see ~/.kinfold']) {
    expect(text).toContain(expected)
  }
})

test('a folder that only starts like the home is left as it is', async () => {
  const term = fakeTerminal([])
  world = createWorld({ terminal: term, interactive: true })
  const ui = await uiFor(world.env, { yes: false })
  ui.output.say(`${world.home}-backup/file and ${world.home}2`)
  expect(visible(term)).toContain(`${world.home}-backup/file and ${world.home}2`)
})

test('the plain renderer keeps full paths: a script reads what it always read', async () => {
  world = createWorld({ terminal: null })
  const ui = await uiFor(world.env, { yes: false })
  ui.output.say(`data dir ${world.home}/.kinfold: modes ok`)
  ui.output.section('hosts', [{ mark: 'ok', text: `claude-code: yes in ${world.home}/.claude.json` }])
  expect(world.out).toEqual([`data dir ${world.home}/.kinfold: modes ok`, 'hosts:', `  claude-code: yes in ${world.home}/.claude.json`])
})
