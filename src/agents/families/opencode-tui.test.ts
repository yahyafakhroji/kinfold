// The folder Kinfold puts beside its OpenCode plugin for the recall toast:
// what install writes, what it leaves alone, what uninstall takes back, and
// that the TUI part toasts the daemon's line and nothing else. The call
// itself was checked against a real OpenCode 2.2.5 TUI in a throwaway HOME;
// here the part runs against a stand-in for `@opencode/plugin/tui`.

import { afterEach, beforeEach, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { type Action, applyAction } from '../../install/plan'
import type { InstallEnv } from '../../install/env'
import { type FakeWorld, createWorld } from '../../install/test-support'
import { OPENCODE_PROFILE } from '../profiles/opencode'
import {
  OPENCODE_TUI_DIR, opencodeTuiContent, opencodeTuiDir, opencodeTuiInstallActions, opencodeTuiServerContent, opencodeTuiUninstallActions,
} from './opencode-tui'

let world: FakeWorld
beforeEach(() => {
  world = createWorld({})
})
afterEach(async () => {
  await world.cleanup()
})

const files = (dir: string): string[] => (existsSync(dir) ? readdirSync(dir).sort() : [])
async function executePlan(env: InstallEnv, actions: readonly Action[]): Promise<void> {
  for (const action of actions) await applyAction(env, action)
}
const run = (actions: readonly Action[]): Promise<void> => executePlan(world.env, actions)

test('install writes a server part and a TUI part in a folder of their own, once', async () => {
  const dir = opencodeTuiDir(world.env)
  expect(dir).toBe(join(world.home, '.config', 'opencode', 'plugins', OPENCODE_TUI_DIR))
  const actions = opencodeTuiInstallActions(world.env)
  expect(actions.map((action) => action.kind)).toEqual(['mkdir', 'write', 'write'])
  await run(actions)
  expect(files(dir)).toEqual(['server.js', 'tui.js'])
  expect(readFileSync(join(dir, 'tui.js'), 'utf8')).toBe(opencodeTuiContent(world.env.dataDir))
  expect(readFileSync(join(dir, 'server.js'), 'utf8')).toBe(opencodeTuiServerContent())
  // A second install has nothing to do.
  expect(opencodeTuiInstallActions(world.env)).toEqual([])
})

test('a part that points at another data folder is rewritten; a file that is not ours stops the folder from being touched', async () => {
  const dir = opencodeTuiDir(world.env)
  await run(opencodeTuiInstallActions(world.env))
  writeFileSync(join(dir, 'tui.js'), opencodeTuiContent('/some/other/data'))
  const stale = opencodeTuiInstallActions(world.env)
  expect(stale.map((action) => action.kind)).toEqual(['write'])
  await run(stale)
  expect(readFileSync(join(dir, 'tui.js'), 'utf8')).toBe(opencodeTuiContent(world.env.dataDir))

  writeFileSync(join(dir, 'tui.js'), '// someone else wrote this\nexport default {}\n')
  world.out.length = 0
  expect(opencodeTuiInstallActions(world.env)).toEqual([])
  expect(world.out.join('\n')).toContain('is not a Kinfold file; the recall toast is not installed')
  expect(opencodeTuiUninstallActions(world.env).map((action) => action.kind)).toEqual(['remove'])
})

test('uninstall removes both parts and the folder when nothing else is in it, and keeps a folder that holds more', async () => {
  const dir = opencodeTuiDir(world.env)
  expect(opencodeTuiUninstallActions(world.env)).toEqual([])
  await run(opencodeTuiInstallActions(world.env))
  await run(opencodeTuiUninstallActions(world.env))
  expect(existsSync(dir)).toBe(false)

  await run(opencodeTuiInstallActions(world.env))
  writeFileSync(join(dir, 'notes.txt'), 'kept')
  await run(opencodeTuiUninstallActions(world.env))
  expect(files(dir)).toEqual(['notes.txt'])
})

test('the OpenCode profile installs the folder with its plugin and takes it out on uninstall', async () => {
  const bundle = '// Kinfold OpenCode plugin (test stand-in)\nexport default {}\n'
  const assets = { opencodePlugin: async () => bundle } as never
  const install = await OPENCODE_PROFILE.wiring.install(world.env, { opencodeAssets: assets })
  expect(install.some((action) => action.kind === 'write' && action.path === join(opencodeTuiDir(world.env), 'tui.js'))).toBe(true)
  await executePlan(world.env, install)
  expect(files(opencodeTuiDir(world.env))).toEqual(['server.js', 'tui.js'])
  await executePlan(world.env, OPENCODE_PROFILE.wiring.uninstall(world.env))
  expect(existsSync(opencodeTuiDir(world.env))).toBe(false)
})

// --- the TUI part itself, against a stand-in for OpenCode's TUI plugin module ---

interface Toast { title?: string; message: string; variant?: string; duration?: number; sessionID?: string }

/** Loads the generated tui.js with `@opencode/plugin/tui` swapped for a stand-in, and runs its setup. */
async function loadPart(dataDir: string, name: string): Promise<{ toasts: Toast[]; stop: () => void }> {
  const dir = join(world.root, name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'stand-in.js'), 'export const Plugin = { define: (plugin) => plugin };\n')
  const source = opencodeTuiContent(dataDir).replace("'@opencode/plugin/tui'", "'./stand-in.js'").replace('const POLL_MS = 1000;', 'const POLL_MS = 20;').replace('const LIST_HOLD_MS = 6000;', 'const LIST_HOLD_MS = 150;')
  writeFileSync(join(dir, 'tui.js'), source)
  const part = (await import(join(dir, 'tui.js'))) as { default: { id: string; setup(context: unknown): () => void } }
  expect(part.default.id).toBe('kinfold.recall')
  const toasts: Toast[] = []
  const stop = part.default.setup({ ui: { toast: { show: (toast: Toast) => void toasts.push(toast) } } })
  return { toasts, stop }
}

const settle = (ms = 120): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

test("the TUI part starts from now, then toasts each new OpenCode prompt's line once, tied to its session", async () => {
  const dataDir = join(world.root, 'data-live')
  mkdirSync(dataDir, { recursive: true })
  const asked: string[] = []
  let answers: unknown[] = [{ cursor: 4, rows: [{ line: 'kinfold · old prompt', hostSessionId: 'ses_old' }] }]
  const server = Bun.serve({
    hostname: '127.0.0.1', port: 0,
    fetch: (request) => {
      const url = new URL(request.url)
      asked.push(`${request.headers.get('authorization')} ${url.pathname}${url.search}`)
      return Response.json(answers.shift() ?? { cursor: 6, rows: [] })
    },
  })
  writeFileSync(join(dataDir, 'daemon.json'), JSON.stringify({ pid: 1, port: server.port }))
  writeFileSync(join(dataDir, 'daemon.token'), 'tok-123\n')
  try {
    answers.push({ cursor: 6, rows: [
      { line: 'kinfold · recalled 1 (new from other sessions) · #16 A title', hostSessionId: 'ses_1' },
      { line: 'kinfold · nothing recalled', hostSessionId: 'ses_2' },
      { line: 42 }, { hostSessionId: 'ses_3' },
    ] })
    const part = await loadPart(dataDir, 'part-live')
    // Waits for the polls themselves, not for a fixed time: a loaded machine runs the timer late.
    for (let waited = 0; (part.toasts.length < 2 || asked.length < 3) && waited < 5_000; waited += 10) await settle(10)
    part.stop()
    // The first answer is only the starting point; what it carried is never replayed.
    expect(part.toasts).toEqual([
      { title: 'Kinfold', message: 'recalled 1 (new from other sessions) · #16 A title', variant: 'info', duration: 8000, sessionID: 'ses_1' },
      { title: 'Kinfold', message: 'nothing recalled', variant: 'info', duration: 8000, sessionID: 'ses_2' },
    ])
    // No daemon here names a start cursor, so the part keeps asking for starts from now.
    expect(asked[0]).toBe('Bearer tok-123 /watch?host=opencode&startsAfter=now')
    expect(asked[1]).toBe('Bearer tok-123 /watch?host=opencode&after=4&startsAfter=now')
    expect(asked[2]).toBe('Bearer tok-123 /watch?host=opencode&after=6&startsAfter=now')
    // Stopped: its timer is gone. One request may still have been in flight when it stopped.
    await settle(60)
    const count = asked.length
    await settle(100)
    expect(asked.length).toBe(count)
  } finally {
    await server.stop(true)
  }
})

test('with the recall line off, or with no daemon, the TUI part shows nothing and does not throw', async () => {
  const dataDir = join(world.root, 'data-off')
  mkdirSync(dataDir, { recursive: true })
  const none = await loadPart(dataDir, 'part-none')
  await settle(60)
  none.stop()
  expect(none.toasts).toEqual([])

  let answers: unknown[] = [{ cursor: 1, rows: [] }, { cursor: 2, rows: [{ line: 'kinfold · nothing recalled', hostSessionId: 's' }] }]
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => Response.json(answers.shift() ?? { cursor: 2, rows: [] }) })
  writeFileSync(join(dataDir, 'daemon.json'), JSON.stringify({ pid: 1, port: server.port }))
  writeFileSync(join(dataDir, 'daemon.token'), 'tok')
  writeFileSync(join(dataDir, 'display.json'), JSON.stringify({ showRecall: false }))
  try {
    const off = await loadPart(dataDir, 'part-off')
    await settle()
    off.stop()
    expect(off.toasts).toEqual([])
  } finally {
    await server.stop(true)
  }
})

test("the TUI part toasts a new session's list once, and holds the first prompt's line until the list has had its time", async () => {
  const dataDir = join(world.root, 'data-starts')
  mkdirSync(dataDir, { recursive: true })
  const asked: string[] = []
  const list = 'kinfold · repo · 12 memories · last session 2h ago\n  #7 CI pins Bun (2h)\n  … 4 more · kinfold dashboard'
  const answers: unknown[] = [
    // The first answer is the starting point: a start it carried is never replayed.
    { cursor: 4, rows: [], startCursor: 9, starts: [{ id: 9, hostSessionId: 'ses_old', list: 'kinfold · old' }] },
    { cursor: 4, rows: [], startCursor: 11, starts: [{ id: 11, hostSessionId: 'ses_1', list }, { id: 10, list: 42 }, { hostSessionId: 'ses_x' }] },
    { cursor: 5, rows: [{ line: 'kinfold · recalled 1 · #7 CI pins Bun', hostSessionId: 'ses_1' }], startCursor: 11, starts: [] },
  ]
  const server = Bun.serve({
    hostname: '127.0.0.1', port: 0,
    fetch: (request) => {
      const url = new URL(request.url)
      asked.push(`${url.pathname}${url.search}`)
      return Response.json(answers.shift() ?? { cursor: 5, rows: [], startCursor: 11, starts: [] })
    },
  })
  writeFileSync(join(dataDir, 'daemon.json'), JSON.stringify({ pid: 1, port: server.port }))
  writeFileSync(join(dataDir, 'daemon.token'), 'tok')
  try {
    const part = await loadPart(dataDir, 'part-starts')
    const shownAt: number[] = []
    for (let waited = 0; part.toasts.length < 2 && waited < 5_000; waited += 5) {
      await settle(5)
      while (shownAt.length < part.toasts.length) shownAt.push(Date.now())
    }
    part.stop()
    expect(part.toasts).toEqual([
      { title: 'Kinfold', message: list.replace(/^kinfold · /, ''), variant: 'info', duration: 12000, sessionID: 'ses_1' },
      { title: 'Kinfold', message: 'recalled 1 · #7 CI pins Bun', variant: 'info', duration: 8000, sessionID: 'ses_1' },
    ])
    // A new toast replaces the one on screen, so the line waits for the list's hold (150 ms here) instead of wiping it at once.
    expect(shownAt[1]! - shownAt[0]!).toBeGreaterThanOrEqual(120)
    expect(asked[0]).toBe('/watch?host=opencode&startsAfter=now')
    expect(asked[1]).toBe('/watch?host=opencode&after=4&startsAfter=9')
    expect(asked[2]).toBe('/watch?host=opencode&after=4&startsAfter=11')
  } finally {
    await server.stop(true)
  }
})

test('a toast still waiting behind a list is dropped when the TUI part stops', async () => {
  const dataDir = join(world.root, 'data-stop')
  mkdirSync(dataDir, { recursive: true })
  const answers: unknown[] = [
    { cursor: 1, rows: [], startCursor: 1, starts: [] },
    { cursor: 2, rows: [{ line: 'kinfold · nothing recalled', hostSessionId: 's' }], startCursor: 2, starts: [{ id: 2, hostSessionId: 's', list: 'kinfold · repo · 1 memory' }] },
  ]
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => Response.json(answers.shift() ?? { cursor: 2, rows: [], startCursor: 2, starts: [] }) })
  writeFileSync(join(dataDir, 'daemon.json'), JSON.stringify({ pid: 1, port: server.port }))
  writeFileSync(join(dataDir, 'daemon.token'), 'tok')
  try {
    const part = await loadPart(dataDir, 'part-stop')
    for (let waited = 0; part.toasts.length < 1 && waited < 5_000; waited += 5) await settle(5)
    part.stop()
    await settle(250)
    // The list came first, in the same answer as the line; the line was still waiting when the part stopped.
    expect(part.toasts.map((toast) => toast.message)).toEqual(['repo · 1 memory'])
  } finally {
    await server.stop(true)
  }
})
