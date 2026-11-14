import { afterEach, expect, test } from 'bun:test'
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { CLAUDE_JSON_HOOKS, mergeSamHooks, removeSamHooks } from '../../install/claude-hooks'
import { entryCommand } from '../../install/entry'
import { CODEX_HOOK_SPEC, CURSOR_HOOK_SPEC, mergeHostHooks, removeHostHooks } from '../../install/host-hooks'
import { type FakeWorld, createWorld } from '../../install/test-support'
import { cmdCommand, powershellCommand } from './hook-shell'
import { type JsonHooksSpec, hookTarget, inspectJsonHooks, jsonHookItem, jsonHooksActions, jsonHooksUninstallActions, mergeJsonHooks, removeJsonHooks, shellCommand } from './json-hooks'
import { assertWriterContract, fileWriter } from './writer-contract.test-support'

let worlds: FakeWorld[] = []
afterEach(async () => {
  for (const w of worlds) await w.cleanup()
  worlds = []
})

const ENTRY = { command: '/Users/dev/.bun/bin/bun', args: ['/Users/dev/sam/src/cli/hook.ts', '--data-dir', '/Users/dev/.kinfold'] }
const forHost = (host: string) => ({ entry: { command: ENTRY.command, args: [...ENTRY.args, '--host', host] } })
const CMD = (host: string) => `'/Users/dev/.bun/bin/bun' '/Users/dev/sam/src/cli/hook.ts' --data-dir '/Users/dev/.kinfold' --host ${host}`

// What mergeSamHooks and mergeHostHooks wrote before they moved onto json-hooks.ts.
const CLAUDE_IN = { theme: 'dark', hooks: { PostToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: '/usr/local/bin/other-tool', timeout: 5 }] }] } }
const claudeOurs = (async: boolean) => ({ type: 'command', command: ENTRY.command, args: ENTRY.args, timeout: 10, ...(async ? { async: true } : {}) })
const CLAUDE_GOLDEN = {
  theme: 'dark',
  hooks: {
    PostToolUse: [CLAUDE_IN.hooks.PostToolUse[0], { matcher: '*', hooks: [claudeOurs(true)] }],
    SessionStart: [{ hooks: [claudeOurs(false)] }],
    UserPromptSubmit: [{ hooks: [claudeOurs(false)] }],
    PostToolUseFailure: [{ matcher: '*', hooks: [claudeOurs(true)] }],
    Stop: [{ hooks: [claudeOurs(false)] }],
    SessionEnd: [{ hooks: [claudeOurs(false)] }],
  },
}

const CODEX_IN = { description: 'mine', hooks: { PostToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: './check.sh', timeout: 30 }] }] } }
const codexOurs = (timeout: number, async = false) => ({ hooks: [{ type: 'command', command: CMD('codex'), timeout, ...(async ? { async: true } : {}) }] })
const CODEX_GOLDEN = {
  description: 'mine',
  hooks: {
    PostToolUse: [CODEX_IN.hooks.PostToolUse[0], codexOurs(10, true)],
    SessionStart: [codexOurs(10)],
    UserPromptSubmit: [codexOurs(10)],
    Stop: [codexOurs(10)],
    SessionEnd: [codexOurs(3)],
  },
}

const CURSOR_IN = { hooks: { stop: [{ command: '/bin/sh x.sh', timeout: 10 }] } }
const cursorOurs = { command: CMD('cursor'), timeout: 10 }
const CURSOR_GOLDEN = {
  version: 1,
  hooks: {
    stop: [CURSOR_IN.hooks.stop[0], cursorOurs],
    sessionStart: [cursorOurs],
    beforeSubmitPrompt: [cursorOurs],
    postToolUse: [cursorOurs],
    postToolUseFailure: [cursorOurs],
    afterAgentResponse: [cursorOurs],
    sessionEnd: [cursorOurs],
  },
}

const GEMINI: JsonHooksSpec = { shape: 'gemini', events: ['SessionStart', 'BeforeAgent', 'AfterTool', 'SessionEnd'], hooksKey: 'hooks', timeoutS: 10, host: 'gemini-cli' }

test('mergeJsonHooks for the claude shape reproduces mergeSamHooks output on the recorded Claude settings', () => {
  const merged = mergeJsonHooks(CLAUDE_JSON_HOOKS, CLAUDE_IN, { entry: ENTRY })
  expect(merged.changed).toBe(true)
  expect(JSON.stringify(merged.settings)).toBe(JSON.stringify(CLAUDE_GOLDEN))
  expect(merged.settings).toEqual(mergeSamHooks(CLAUDE_IN, { entry: ENTRY }).settings)
  expect(removeJsonHooks(CLAUDE_JSON_HOOKS, merged.settings)).toEqual(removeSamHooks(merged.settings))
  expect(inspectJsonHooks(CLAUDE_JSON_HOOKS, merged.settings, ENTRY)).toBe('yes')
})

test('mergeJsonHooks for the command shape reproduces mergeHostHooks for Codex and Cursor', () => {
  const codex = mergeJsonHooks(CODEX_HOOK_SPEC, CODEX_IN, forHost('codex'))
  expect(JSON.stringify(codex.settings)).toBe(JSON.stringify(CODEX_GOLDEN))
  expect(codex.settings).toEqual(mergeHostHooks(CODEX_HOOK_SPEC, CODEX_IN, forHost('codex')).settings)
  const cursor = mergeJsonHooks(CURSOR_HOOK_SPEC, CURSOR_IN, forHost('cursor'))
  expect(JSON.stringify(cursor.settings)).toBe(JSON.stringify(CURSOR_GOLDEN))
  expect(removeHostHooks(CURSOR_HOOK_SPEC, cursor.settings).settings).toEqual({ version: 1, hooks: CURSOR_IN.hooks })
  // A Codex entry in a Cursor file is not Cursor's: ours is found by the host it names too.
  expect(removeJsonHooks(CURSOR_HOOK_SPEC, { hooks: { stop: [{ command: CMD('codex') }] } }).removed).toBe(0)
})

test('the gemini shape nests like Claude, runs one shell string, and counts its timeout in milliseconds', () => {
  const merged = mergeJsonHooks(GEMINI, { theme: 'x' }, forHost('gemini-cli'))
  expect(merged.settings).toEqual({
    theme: 'x',
    hooks: Object.fromEntries(GEMINI.events.map((event) => [event, [{ hooks: [{ type: 'command', command: CMD('gemini-cli'), timeout: 10_000 }] }]])),
  })
  expect(mergeJsonHooks(GEMINI, merged.settings, forHost('gemini-cli')).changed).toBe(false)
  expect(inspectJsonHooks(GEMINI, merged.settings, forHost('gemini-cli').entry)).toBe('yes')
  expect(removeJsonHooks(GEMINI, merged.settings)).toEqual({ settings: { theme: 'x' }, removed: 4 })
})

function geminiWorld(): { w: FakeWorld; path: string } {
  const w = createWorld()
  worlds.push(w)
  return { w, path: join(w.home, '.gemini', 'settings.json') }
}

test.each([
  ['comments', '{\n  // my theme\n  "theme": "dark"\n}\n'],
  ['trailing commas', '{\n  "theme": "dark",\n}\n'],
])('a settings file with %s is refused untouched, with "not plain JSON" in the reason', (_name, text) => {
  const { w, path } = geminiWorld()
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
  expect(jsonHooksActions(w.env, path, GEMINI, 'gemini-cli')).toEqual([])
  expect(jsonHooksUninstallActions(w.env, path, GEMINI)).toEqual([])
  expect(readFileSync(path, 'utf8')).toBe(text)
  expect(readdirSync(dirname(path))).toEqual(['settings.json'])
  const reasons = w.out.filter((line) => line.startsWith('gemini-cli:'))
  expect(reasons).toHaveLength(2)
  for (const line of reasons) expect(line).toContain('not plain JSON')
})

test('install twice then uninstall gives back the original bytes, with one backup', () => {
  const userFile = `${JSON.stringify({ theme: 'dark', hooks: { AfterTool: [{ matcher: 'write_file', hooks: [{ type: 'command', command: 'lint.sh' }] }] } }, null, 2)}\n`
  for (const before of [null, userFile, '{"theme":"dark"}', '{ "theme" : "dark" }\n']) {
    const { w, path } = geminiWorld()
    const { write, remove } = fileWriter(path, () => jsonHooksActions(w.env, path, GEMINI, 'gemini-cli'), () => jsonHooksUninstallActions(w.env, path, GEMINI))
    assertWriterContract(write, remove, [before])
    expect(readdirSync(dirname(path)).filter((name) => name.includes('.kinfold-backup-'))).toHaveLength(1)
    expect(w.out).toContain(`gemini-cli: hooks already wired in ${path}`)
  }
})

test('the claude-code host keeps the command without --host, as today', () => {
  const { w, path } = geminiWorld()
  const [write] = jsonHooksActions(w.env, path, CLAUDE_JSON_HOOKS, 'claude-code').filter((action) => action.kind === 'write')
  const text = write?.kind === 'write' ? write.content : ''
  expect(JSON.parse(text).hooks.Stop[0].hooks[0].args).toEqual(entryCommand(w.env.mode, 'hook', w.env.dataDir).args)
})

const WIN_ENTRY = { command: "C:\\Users\\O'Brien\\.kinfold\\bin\\kinfold.exe", args: ['--data-dir', "C:\\Users\\O'Brien\\.kinfold", 'hook', '--host', 'gemini-cli'] }
const POWERSHELL: JsonHooksSpec = { ...GEMINI, windowsShell: 'powershell' }
const CMD_SPEC: JsonHooksSpec = { shape: 'command', grouped: false, events: ['Stop'], hooksKey: 'hooks', timeoutS: 10, host: 'gemini-cli', windowsShell: 'cmd' }

test('on Windows the command is written for the shell the agent runs it through', () => {
  const onWindows = { entry: WIN_ENTRY, windows: true }
  expect(jsonHookItem(POWERSHELL, 'SessionStart', onWindows)).toEqual({ hooks: [{ type: 'command', command: powershellCommand(WIN_ENTRY), timeout: 10_000 }] })
  expect(jsonHookItem(CMD_SPEC, 'Stop', onWindows)).toEqual({ command: cmdCommand(WIN_ENTRY), timeout: 10 })
  // Off Windows, and for an agent with no documented Windows shell, the POSIX string stays.
  expect(jsonHookItem(POWERSHELL, 'SessionStart', { entry: WIN_ENTRY })).toEqual({ hooks: [{ type: 'command', command: shellCommand(WIN_ENTRY), timeout: 10_000 }] })
  expect(jsonHookItem(GEMINI, 'SessionStart', onWindows)).toEqual({ hooks: [{ type: 'command', command: shellCommand(WIN_ENTRY), timeout: 10_000 }] })
})

test('windowsEntry adds its fields to the entry on Windows only', () => {
  const spec: JsonHooksSpec = { ...POWERSHELL, windowsEntry: { shell: 'powershell' } }
  expect(jsonHookItem(spec, 'SessionStart', { entry: WIN_ENTRY, windows: true })).toEqual({
    hooks: [{ type: 'command', command: powershellCommand(WIN_ENTRY), timeout: 10_000, shell: 'powershell' }],
  })
  expect(jsonHookItem(spec, 'SessionStart', { entry: WIN_ENTRY })).toEqual({ hooks: [{ type: 'command', command: shellCommand(WIN_ENTRY), timeout: 10_000 }] })
})

test('a Windows-form entry is ours: a re-run changes nothing, state reads yes and uninstall takes it out', () => {
  for (const spec of [POWERSHELL, CMD_SPEC]) {
    const target = { entry: WIN_ENTRY, windows: true }
    const merged = mergeJsonHooks(spec, { theme: 'x' }, target)
    expect(mergeJsonHooks(spec, merged.settings, target).changed).toBe(false)
    expect(inspectJsonHooks(spec, merged.settings, WIN_ENTRY, true)).toBe('yes')
    expect(removeJsonHooks(spec, merged.settings)).toEqual({ settings: { theme: 'x' }, removed: spec.events.length })
  }
})

test('a POSIX string left by an older install reads stale on Windows and is replaced, not added to', () => {
  const old = mergeJsonHooks(POWERSHELL, {}, { entry: WIN_ENTRY }).settings
  expect(inspectJsonHooks(POWERSHELL, old, WIN_ENTRY, true)).toBe('stale')
  expect(inspectJsonHooks(POWERSHELL, old, WIN_ENTRY)).toBe('yes')
  const merged = mergeJsonHooks(POWERSHELL, old, { entry: WIN_ENTRY, windows: true })
  expect(merged.replaced).toEqual([...POWERSHELL.events])
  expect(merged.added).toEqual([])
  expect(inspectJsonHooks(POWERSHELL, merged.settings, WIN_ENTRY, true)).toBe('yes')
})

test('hookTarget says whether the env is Windows', () => {
  const win = createWorld({ platform: 'win32' })
  const mac = createWorld()
  worlds.push(win, mac)
  expect(hookTarget(win.env, 'copilot').windows).toBe(true)
  expect(hookTarget(mac.env, 'copilot').windows).toBe(false)
})
