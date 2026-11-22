import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ObserverError } from '../types'
import { type SpawnRequest, claudeCliArgs, createClaudeCliRunner } from './claude-cli'
import { resolveCmdShim, withCmdShims } from './windows-shim'

let npmDir: string
beforeEach(() => {
  npmDir = mkdtempSync(join(tmpdir(), 'sam-cmd-shim-'))
})
afterEach(() => rmSync(npmDir, { recursive: true, force: true }))

// npm cmd-shim's output for a JS bin, as `npm i -g @anthropic-ai/claude-code` writes it.
const JS_SHIM = [
  '@ECHO off', 'GOTO start', ':find_dp0', 'SET dp0=%~dp0', 'EXIT /b', ':start', 'SETLOCAL', 'CALL :find_dp0', '',
  'IF EXIST "%dp0%\\node.exe" (', '  SET "_prog=%dp0%\\node.exe"', ') ELSE (', '  SET "_prog=node"', '  SET PATHEXT=%PATHEXT:;.JS;=;%', ')', '',
  'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*',
].join('\r\n')
// cmd-shim's output for a bin that is a native program.
const EXE_SHIM = ['@ECHO off', 'GOTO start', ':find_dp0', 'SET dp0=%~dp0', 'EXIT /b', ':start', 'SETLOCAL', 'CALL :find_dp0',
  '"%dp0%\\node_modules\\opencode-ai\\bin\\opencode.exe"   %*'].join('\r\n')

function place(relative: string, content = ''): string {
  const path = join(npmDir, ...relative.split('\\'))
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, content)
  return path
}

const NODE = 'C:\\Program Files\\nodejs\\node.exe'
const whichNode = (command: string) => (command === 'node' ? NODE : null)

test('a JS-target shim resolves to node plus the script under the shim folder', () => {
  const shim = place('claude.cmd', JS_SHIM)
  const script = place('node_modules\\@anthropic-ai\\claude-code\\cli.js')
  expect(resolveCmdShim(shim, undefined, undefined, whichNode)).toEqual({ argv0: [NODE, script] })
})

test('a shim beside node.exe runs that node, as the shim itself would', () => {
  const shim = place('claude.cmd', JS_SHIM)
  const script = place('node_modules\\@anthropic-ai\\claude-code\\cli.js')
  const node = place('node.exe')
  expect(resolveCmdShim(shim, undefined, undefined, whichNode)).toEqual({ argv0: [node, script] })
})

test('an exe-target shim resolves to the exe', () => {
  const shim = place('opencode.cmd', EXE_SHIM)
  const exe = place('node_modules\\opencode-ai\\bin\\opencode.exe')
  expect(resolveCmdShim(shim, undefined, undefined, whichNode)).toEqual({ argv0: [exe] })
})

test('a .cmd that is not an npm shim, a missing target, or no node resolves to null', () => {
  expect(resolveCmdShim(place('custom.cmd', '@echo off\r\ncall something.bat %*'), undefined, undefined, whichNode)).toBeNull()
  expect(resolveCmdShim(place('claude.cmd', JS_SHIM), undefined, undefined, whichNode)).toBeNull()
  place('node_modules\\@anthropic-ai\\claude-code\\cli.js')
  expect(resolveCmdShim(join(npmDir, 'claude.cmd'), undefined, undefined, () => null)).toBeNull()
})

test('a shim whose direct target is a .bat or .cmd resolves to null, since Windows would run it through cmd.exe', () => {
  for (const target of ['node_modules\\p\\evil.bat', 'node_modules\\p\\evil.CMD', 'node_modules\\p\\cli.js']) {
    place(target)
    const shim = EXE_SHIM.replace('node_modules\\opencode-ai\\bin\\opencode.exe', target)
    expect(resolveCmdShim(place('opencode.cmd', shim), undefined, undefined, whichNode)).toBeNull()
  }
})

test('a shim whose target leaves its folder resolves to null', () => {
  const escaping = JS_SHIM.replace('node_modules\\@anthropic-ai\\claude-code\\cli.js', '..\\elsewhere\\cli.js')
  place('..\\elsewhere\\cli.js')
  expect(resolveCmdShim(place('claude.cmd', escaping), undefined, undefined, whichNode)).toBeNull()
})

test('a spawn of a .cmd runs its target with every argument passed through as is, never through cmd.exe', async () => {
  const shim = place('claude.cmd', JS_SHIM)
  const script = place('node_modules\\@anthropic-ai\\claude-code\\cli.js')
  const seen: SpawnRequest[] = []
  const spawn = withCmdShims(async (request) => {
    seen.push(request)
    return { exitCode: 0, stdout: 'ok', timedOut: false }
  }, (path) => resolveCmdShim(path, undefined, undefined, whichNode))
  const prompt = 'Summarize & then | echo "%PATH%" > out.txt'
  await spawn({ cmd: [shim, '--system-prompt', prompt], cwd: npmDir, env: {}, stdin: '', timeoutMs: 1_000 })
  expect(seen[0]!.cmd).toEqual([NODE, script, '--system-prompt', prompt])
  expect(seen[0]!.cmd.some((part) => /cmd\.exe$/i.test(part))).toBe(false)

  // Anything else is spawned unchanged.
  await spawn({ cmd: ['C:\\tools\\claude.exe', '--version'], cwd: npmDir, env: {}, stdin: '', timeoutMs: 1_000 })
  expect(seen[1]!.cmd).toEqual(['C:\\tools\\claude.exe', '--version'])
})

test('the Claude runner runs an npm claude.cmd as node plus its script, with the system prompt as one argument', async () => {
  const shim = place('claude.cmd', JS_SHIM)
  const script = place('node_modules\\@anthropic-ai\\claude-code\\cli.js')
  const node = place('node.exe')
  const dataDir = join(npmDir, 'data')
  const seen: SpawnRequest[] = []
  const reply = JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'OK', modelUsage: {}, usage: {} })
  const runner = createClaudeCliRunner({
    dataDir, model: 'haiku', which: () => shim, parentEnv: { PATH: npmDir },
    spawn: async (request) => {
      seen.push(request)
      return { exitCode: 0, stdout: reply, timedOut: false }
    },
  })
  const system = 'Rules & limits | "quoted" %PATH%'
  expect((await runner.run({ system, user: 'events', eventIds: [] })).text).toBe('OK')
  expect(seen[0]!.cmd.slice(0, 2)).toEqual([node, script])
  expect(seen[0]!.cmd).toEqual([node, script, ...claudeCliArgs(shim, 'haiku', system).slice(1)])
})

test('a .cmd that cannot be resolved is refused as a missing CLI, with no shell fallback', async () => {
  const spawn = withCmdShims(async () => ({ exitCode: 0, stdout: '', timedOut: false }), () => null)
  const failure = await spawn({ cmd: ['C:\\x\\custom.cmd', '--version'], cwd: npmDir, env: {}, stdin: '', timeoutMs: 1_000 }).catch((error: unknown) => error)
  expect(failure).toBeInstanceOf(ObserverError)
  expect((failure as ObserverError).errorClass).toBe('cli_missing')
  expect((failure as ObserverError).message).toContain('custom.cmd is a .cmd file that is not an npm shim')
})
