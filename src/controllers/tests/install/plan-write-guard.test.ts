// A config file the user or an agent also edits is merged at plan time and
// written many steps later (after downloads, a service stop, the program
// copy). A save made in between must not be lost to the planned text.

import { afterEach, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { claudeHookInstallActions } from './claude-wiring'
import { installPaths } from './env'
import { readTextOrNull } from './files'
import { type Action, ChangedSincePlannedError, applyAction, runPlan } from './plan'
import { type FakeWorld, createWorld } from './test-support'

let world: FakeWorld | null = null
afterEach(async () => {
  await world?.cleanup()
  world = null
})

const write = (path: string, content: string, before: string | null | undefined): Action => ({ kind: 'write', path, content, mode: 0o600, summary: 'test', ...(before !== undefined ? { before } : {}) })

test('a file saved by someone else after the plan read it is left as it is, and the step fails by name', async () => {
  world = createWorld()
  const path = join(world.root, 'settings.json')
  writeFileSync(path, '{"theirs": 1}\n')
  const planned = write(path, '{"theirs": 1, "ours": true}\n', '{"theirs": 1}\n')
  // The user saves the file while the install downloads and copies.
  writeFileSync(path, '{"theirs": 2, "new": "kept"}\n')
  await expect(applyAction(world.env, planned)).rejects.toThrow(ChangedSincePlannedError)
  expect(readFileSync(path, 'utf8')).toBe('{"theirs": 2, "new": "kept"}\n')
})

test('a file that appeared, or went away, since the plan is not written over either', async () => {
  world = createWorld()
  const appeared = join(world.root, 'appeared.json')
  const planned = write(appeared, '{"ours": true}\n', null)
  writeFileSync(appeared, '{"theirs": 1}\n')
  await expect(applyAction(world.env, planned)).rejects.toThrow(`${appeared} changed while this was running`)
  expect(readFileSync(appeared, 'utf8')).toBe('{"theirs": 1}\n')

  const gone = join(world.root, 'gone.json')
  await expect(applyAction(world.env, write(gone, '{}\n', '{"was": "here"}\n'))).rejects.toThrow(ChangedSincePlannedError)
  expect(existsSync(gone)).toBe(false)
})

test('an unchanged file is written, a new file is made, and a file with no recorded text is written as before', async () => {
  world = createWorld()
  const path = join(world.root, 'settings.json')
  writeFileSync(path, '{"theirs": 1}\n')
  await applyAction(world.env, write(path, '{"theirs": 1, "ours": true}\n', '{"theirs": 1}\n'))
  expect(readFileSync(path, 'utf8')).toBe('{"theirs": 1, "ours": true}\n')
  const fresh = join(world.root, 'fresh.json')
  await applyAction(world.env, write(fresh, '{"ours": true}\n', null))
  expect(readFileSync(fresh, 'utf8')).toBe('{"ours": true}\n')
  // Our own files (the service config, a plugin shim) carry no `before` and are simply replaced.
  await applyAction(world.env, write(fresh, 'replaced\n', undefined))
  expect(readFileSync(fresh, 'utf8')).toBe('replaced\n')
})

test('a file saved as UTF-16 that nobody touched is read as the plan read it, and written', async () => {
  world = createWorld()
  const path = join(world.root, 'profile.ps1')
  const text = '$env:EDITOR = "code"\r\n'
  writeFileSync(path, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]))
  const before = readTextOrNull(path)
  // Decoded, where a plain UTF-8 read of the same bytes is not this text at all.
  expect(before).toContain(text)
  expect(readFileSync(path, 'utf8')).not.toContain(text)
  await applyAction(world.env, write(path, `${text}# kinfold\r\n`, before))
  expect(readFileSync(path, 'utf8')).toBe(`${text}# kinfold\r\n`)
})

test('two steps of one plan may write the same file: the second finds the first one\'s text, which is not a change by someone else', async () => {
  world = createWorld()
  const path = join(world.root, 'opencode.json')
  writeFileSync(path, '{"a": 1}\n')
  await runPlan(world.env, [write(path, '{"a": 1, "b": 2}\n', '{"a": 1}\n'), write(path, '{"a": 1, "b": 2, "c": 3}\n', '{"a": 1}\n')], false)
  expect(readFileSync(path, 'utf8')).toBe('{"a": 1, "b": 2, "c": 3}\n')
  // A third party's save between the two is still caught.
  writeFileSync(path, '{"edited": true}\n')
  await expect(applyAction(world.env, write(path, '{"x": 1}\n', '{"a": 1}\n'))).rejects.toThrow(ChangedSincePlannedError)
})

test('the Claude Code hooks write carries the settings text it was merged from', () => {
  world = createWorld({ claudeVersion: '2.1.310 (Claude Code)' })
  const { claudeSettings } = installPaths(world.env)
  mkdirSync(dirname(claudeSettings), { recursive: true })
  writeFileSync(claudeSettings, '{"model": "opus"}\n')
  const planned = claudeHookInstallActions(world.env).find((action) => action.kind === 'write')
  expect(planned).toMatchObject({ kind: 'write', path: claudeSettings, before: '{"model": "opus"}\n' })
})
