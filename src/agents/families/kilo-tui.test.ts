// The Kilo Code recall toast: its file, its entry in the user's tui.json, and
// the part itself running against a stand-in for Kilo's TUI api.

import { afterEach, beforeEach, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { runPlan } from '../../install/plan'
import { type FakeWorld, createWorld } from '../../install/test-support'
import { kiloTuiConfigPath, kiloTuiContent, kiloTuiInstallActions, kiloTuiLine, kiloTuiPath, kiloTuiUninstallActions } from './kilo-tui'

let world: FakeWorld
beforeEach(() => {
  world = createWorld()
})
afterEach(async () => {
  await world.cleanup()
})

const install = async (): Promise<void> => runPlan(world.env, kiloTuiInstallActions(world.env), false)
const uninstall = async (): Promise<void> => runPlan(world.env, kiloTuiUninstallActions(world.env), false)
const config = (): Record<string, unknown> => JSON.parse(readFileSync(kiloTuiConfigPath(world.env), 'utf8')) as Record<string, unknown>
const backups = (): string[] => readdirSync(join(world.env.homeDir, '.config', 'kilo')).filter((name) => name.startsWith('tui.json.kinfold-backup-'))

test('install writes the toast and lists it in a new tui.json; a re-run plans nothing; uninstall takes both out', async () => {
  await install()
  expect(readFileSync(kiloTuiPath(world.env), 'utf8')).toBe(kiloTuiContent(world.env.dataDir))
  expect(config()).toEqual({ plugin: [kiloTuiPath(world.env)] })
  expect(kiloTuiLine(world.env)).toBe('recall toast yes')
  expect(kiloTuiInstallActions(world.env)).toEqual([])
  await uninstall()
  expect(existsSync(kiloTuiPath(world.env))).toBe(false)
  expect(existsSync(join(world.env.homeDir, '.config', 'kilo', 'kinfold-recall'))).toBe(false)
  // A tui.json Kinfold created holds nothing else, so it goes too.
  expect(existsSync(kiloTuiConfigPath(world.env))).toBe(false)
  expect(kiloTuiLine(world.env)).toBe('recall toast no')
})

test("the user's tui.json keeps its other keys and plugins, gets a backup first, and is given back byte for byte", async () => {
  const path = kiloTuiConfigPath(world.env)
  mkdirSync(join(world.env.homeDir, '.config', 'kilo'), { recursive: true })
  const mine = '{\n    "theme": "smoke-theme",\n    "plugin": ["@acme/opencode-plugin@1.2.3", ["./plugins/demo.tsx", { "label": "demo" }]]\n}\n'
  writeFileSync(path, mine)
  await install()
  expect(config()).toEqual({ theme: 'smoke-theme', plugin: ['@acme/opencode-plugin@1.2.3', ['./plugins/demo.tsx', { label: 'demo' }], kiloTuiPath(world.env)] })
  expect(backups()).toHaveLength(1)
  expect(readFileSync(join(world.env.homeDir, '.config', 'kilo', backups()[0]!), 'utf8')).toBe(mine)
  await uninstall()
  expect(readFileSync(path, 'utf8')).toBe(mine)
})

test('install and uninstall twice over leave no tui.json and no backup of a file Kinfold made', async () => {
  for (let round = 0; round < 2; round += 1) {
    await install()
    await uninstall()
  }
  expect(existsSync(kiloTuiConfigPath(world.env))).toBe(false)
  expect(backups()).toEqual([])
})

test('our entry is known however its path is spelled: a file URL, or forward slashes', async () => {
  const path = kiloTuiConfigPath(world.env)
  mkdirSync(join(world.env.homeDir, '.config', 'kilo'), { recursive: true })
  const forward = kiloTuiPath(world.env).replaceAll('\\', '/')
  writeFileSync(path, JSON.stringify({ plugin: [pathToFileURL(kiloTuiPath(world.env)).href, forward, 'other'] }))
  await install()
  expect((config().plugin as unknown[]).length).toBe(3)
  await uninstall()
  expect(config()).toEqual({ plugin: ['other'] })
})

test("a tui.json the user had, even an empty one, is given back on uninstall rather than deleted", async () => {
  const path = kiloTuiConfigPath(world.env)
  mkdirSync(join(world.env.homeDir, '.config', 'kilo'), { recursive: true })
  writeFileSync(path, '{}\n')
  await install()
  expect(config()).toEqual({ plugin: [kiloTuiPath(world.env)] })
  await uninstall()
  expect(readFileSync(path, 'utf8')).toBe('{}\n')
})

test('an entry the user wrote for our file, in either form, is not added twice and is taken out on uninstall', async () => {
  const path = kiloTuiConfigPath(world.env)
  mkdirSync(join(world.env.homeDir, '.config', 'kilo'), { recursive: true })
  writeFileSync(path, JSON.stringify({ plugin: [[`file://${kiloTuiPath(world.env)}`, {}], 'other'] }))
  await install()
  expect(config()).toEqual({ plugin: [[`file://${kiloTuiPath(world.env)}`, {}], 'other'] })
  await uninstall()
  expect(config()).toEqual({ plugin: ['other'] })
})

test('a tui.json with comments, or a "plugin" that is not a list, skips the toast and is left untouched', async () => {
  const path = kiloTuiConfigPath(world.env)
  mkdirSync(join(world.env.homeDir, '.config', 'kilo'), { recursive: true })
  for (const text of ['{ // mine\n  "theme": "x",\n}\n', '{"plugin": "one-plugin"}\n']) {
    writeFileSync(path, text)
    await install()
    expect(readFileSync(path, 'utf8')).toBe(text)
    expect(world.out.some((line) => line.startsWith('kilo-code') && line.includes('left untouched'))).toBe(true)
    world.out.length = 0
    rmSync(kiloTuiPath(world.env), { force: true })
  }
})

test('a tui.js by our name that Kinfold did not write is never replaced, and the toast is left out', async () => {
  mkdirSync(join(world.env.homeDir, '.config', 'kilo', 'kinfold-recall'), { recursive: true })
  writeFileSync(kiloTuiPath(world.env), '// someone else wrote this\nexport default {}\n')
  expect(kiloTuiInstallActions(world.env)).toEqual([])
  expect(world.out.some((line) => line.includes('is not a Kinfold file'))).toBe(true)
  expect(kiloTuiUninstallActions(world.env)).toEqual([])
  expect(readFileSync(kiloTuiPath(world.env), 'utf8')).toBe('// someone else wrote this\nexport default {}\n')
})

test('a toast from another data folder is stale and is rewritten; a file left beside ours keeps the folder', async () => {
  mkdirSync(join(world.env.homeDir, '.config', 'kilo', 'kinfold-recall'), { recursive: true })
  writeFileSync(kiloTuiPath(world.env), kiloTuiContent('/some/other/data'))
  writeFileSync(kiloTuiConfigPath(world.env), JSON.stringify({ plugin: [kiloTuiPath(world.env)] }))
  expect(kiloTuiLine(world.env)).toBe('recall toast stale')
  await install()
  expect(readFileSync(kiloTuiPath(world.env), 'utf8')).toBe(kiloTuiContent(world.env.dataDir))
  writeFileSync(join(world.env.homeDir, '.config', 'kilo', 'kinfold-recall', 'notes.txt'), 'mine')
  await uninstall()
  expect(readdirSync(join(world.env.homeDir, '.config', 'kilo', 'kinfold-recall'))).toEqual(['notes.txt'])
})

// --- the part itself ---

interface Toast { title?: string; message: string; variant?: string; duration?: number }

test("the part toasts a new session's list and each prompt's line through api.ui.toast, and stops on dispose", async () => {
  const dataDir = join(world.root, 'data-kilo')
  mkdirSync(dataDir, { recursive: true })
  const asked: string[] = []
  const answers: unknown[] = [
    { cursor: 1, rows: [], startCursor: 1, starts: [] },
    { cursor: 1, rows: [], startCursor: 2, starts: [{ id: 2, hostSessionId: 'ses_k', list: 'kinfold · proj · 4 memories\n  #1 CI pins Bun (2h)' }] },
    { cursor: 2, rows: [{ line: 'kinfold · nothing recalled', hostSessionId: 'ses_k' }], startCursor: 2, starts: [] },
  ]
  const server = Bun.serve({
    hostname: '127.0.0.1', port: 0,
    fetch: (request) => {
      const url = new URL(request.url)
      asked.push(`${url.pathname}${url.search}`)
      return Response.json(answers.shift() ?? { cursor: 2, rows: [], startCursor: 2, starts: [] })
    },
  })
  writeFileSync(join(dataDir, 'daemon.json'), JSON.stringify({ pid: 1, port: server.port }))
  writeFileSync(join(dataDir, 'daemon.token'), 'tok')
  const dir = join(world.root, 'part-kilo')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'tui.js'), kiloTuiContent(dataDir).replace('const POLL_MS = 1000;', 'const POLL_MS = 20;').replace('const LIST_HOLD_MS = 6000;', 'const LIST_HOLD_MS = 60;'))
  try {
    const part = (await import(join(dir, 'tui.js'))) as { default: { id: string; tui(api: unknown): Promise<void> } }
    expect(Object.keys(part.default).sort()).toEqual(['id', 'tui'])
    const toasts: Toast[] = []
    const disposers: (() => void)[] = []
    await part.default.tui({ ui: { toast: (toast: Toast) => void toasts.push(toast) }, lifecycle: { onDispose: (fn: () => void) => void disposers.push(fn) } })
    for (let waited = 0; toasts.length < 2 && waited < 5_000; waited += 5) await Bun.sleep(5)
    expect(toasts).toEqual([
      { title: 'Kinfold', message: 'proj · 4 memories\n  #1 CI pins Bun (2h)', variant: 'info', duration: 12000 },
      { title: 'Kinfold', message: 'nothing recalled', variant: 'info', duration: 8000 },
    ])
    expect(asked[0]).toBe('/watch?host=kilo-code&startsAfter=now')
    expect(disposers).toHaveLength(1)
    disposers[0]!()
    await Bun.sleep(60)
    const count = asked.length
    await Bun.sleep(100)
    expect(asked.length).toBe(count)
  } finally {
    await server.stop(true)
  }
})
