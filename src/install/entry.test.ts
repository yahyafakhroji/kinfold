import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { inspectSamHooks, mergeSamHooks } from './claude-hooks'
import { entryCommand, entryIdentity, installedProgramPath, isCompiledProgram, isOurEntry } from './entry'
import { serializeJson } from './files'
import { samCommand, samCommandScript } from './host-hooks'
import { plistContent } from './launch-agent'
import { MCP_SERVER_NAME, claudeMcpEntry, inspectMcpEntry, openCodeMcpEntry } from './mcp-config'

const HOME = '/Users/me'
const DATA_DIR = '/Users/me/My Memory'
const PROGRAM = '/Users/me/My Memory/bin/kinfold'
const CHECKOUT = { kind: 'checkout', bunPath: '/opt/bun/bin/bun', projectRoot: '/Users/me/kinfold' } as const

describe('the entry command', () => {
  test('a program hook names the installed program and puts the data folder before the subcommand', () => {
    expect(entryCommand({ kind: 'program', binPath: PROGRAM }, 'hook', DATA_DIR, 'opencode')).toEqual({
      command: PROGRAM,
      args: ['--data-dir', DATA_DIR, 'hook', '--host', 'opencode'],
    })
  })

  test('a program MCP server and daemon take the same data folder', () => {
    const mode = { kind: 'program', binPath: PROGRAM } as const
    expect(entryCommand(mode, 'mcp', DATA_DIR)).toEqual({ command: PROGRAM, args: ['--data-dir', DATA_DIR, 'mcp'] })
    expect(entryCommand(mode, 'daemon', DATA_DIR)).toEqual({ command: PROGRAM, args: ['--data-dir', DATA_DIR, 'daemon'] })
  })

  test('a checkout hook is bun on the checkout script, as before, with the host when one is named', () => {
    expect(entryCommand(CHECKOUT, 'hook', DATA_DIR)).toEqual({
      command: CHECKOUT.bunPath,
      args: [join(CHECKOUT.projectRoot, 'src/cli/hook.ts')],
    })
    expect(entryCommand(CHECKOUT, 'hook', DATA_DIR, 'codex').args).toEqual([join(CHECKOUT.projectRoot, 'src/cli/hook.ts'), '--host', 'codex'])
  })

  test('a checkout MCP server and daemon keep their script paths', () => {
    expect(entryCommand(CHECKOUT, 'mcp', DATA_DIR).args).toEqual([join(CHECKOUT.projectRoot, 'src/mcp/server.ts')])
    expect(entryCommand(CHECKOUT, 'daemon', DATA_DIR).args).toEqual([join(CHECKOUT.projectRoot, 'src/daemon/main.ts')])
  })

  test('the installed program lives in the data folder and is an .exe on Windows', () => {
    expect(installedProgramPath(DATA_DIR, 'darwin')).toBe(join(DATA_DIR, 'bin', 'kinfold'))
    expect(installedProgramPath(DATA_DIR, 'linux')).toBe(join(DATA_DIR, 'bin', 'kinfold'))
    expect(installedProgramPath(DATA_DIR, 'win32')).toBe(join(DATA_DIR, 'bin', 'kinfold.exe'))
  })

  test('a compiled program is recognised by the virtual path bun runs it from', () => {
    expect(isCompiledProgram('/$bunfs/root/src/cli/kinfold.ts')).toBe(true)
    expect(isCompiledProgram('B:\\~BUN\\root\\src\\cli\\kinfold.ts')).toBe(true)
    expect(isCompiledProgram('/Users/me/kinfold/src/cli/kinfold.ts')).toBe(false)
  })
})

describe('recognising our entries', () => {
  test('both forms are ours, including a hook command written as one string', () => {
    const program = entryCommand({ kind: 'program', binPath: PROGRAM }, 'hook', DATA_DIR)
    expect(isOurEntry(program.command, program.args)).toBe(true)
    const checkout = entryCommand(CHECKOUT, 'hook', DATA_DIR, 'codex')
    expect(isOurEntry(checkout.command, checkout.args)).toBe(true)
    expect(isOurEntry("'/opt/bun/bin/bun' '/Users/me/kinfold/src/cli/hook.ts' --host codex", [])).toBe(true)
  })

  test('another program, even one whose path contains kinfold, is not ours', () => {
    expect(isOurEntry('node', ['/x/other.js'])).toBe(false)
    expect(isOurEntry('/usr/local/bin/kinfold-helper', ['hook'])).toBe(false)
    expect(isOurEntry('/Users/me/kinfold-notes/bin/hook', ['hook'])).toBe(false)
    expect(isOurEntry('bun', ['/Users/me/kinfold-notes/scripts/hook.ts'])).toBe(false)
  })

  test('a kinfold program outside a bin folder, or with other arguments, is not ours', () => {
    expect(isOurEntry('/Users/me/kinfold', [])).toBe(false)
    expect(isOurEntry('/Users/me/kinfold', ['hook'])).toBe(false)
    expect(isOurEntry('/Users/me/.kinfold/bin/kinfold', ['--version'])).toBe(false)
    expect(isOurEntry('/Users/me/.kinfold/bin/kinfold', ['status'])).toBe(false)
  })
})

describe('a data folder with spaces', () => {
  test('round-trips through Claude settings, both MCP entries and the plist', () => {
    const mode = { kind: 'program', binPath: installedProgramPath(DATA_DIR, 'darwin') } as const
    const hook = entryCommand(mode, 'hook', DATA_DIR)
    const settingsText = serializeJson(mergeSamHooks({}, { entry: hook }).settings, null)
    expect(settingsText).toContain(PROGRAM)
    expect(settingsText).toContain(DATA_DIR)
    expect(inspectSamHooks(JSON.parse(settingsText), entryIdentity(mode, 'hook', DATA_DIR))).toBe('yes')

    const mcp = entryCommand(mode, 'mcp', DATA_DIR)
    const claude = JSON.parse(serializeJson({ mcpServers: { [MCP_SERVER_NAME]: claudeMcpEntry({ entry: mcp }) } }, null))
    expect(inspectMcpEntry(claude, 'claude-code', { entry: mcp })).toBe('yes')
    const opencode = JSON.parse(serializeJson({ mcp: { [MCP_SERVER_NAME]: openCodeMcpEntry({ entry: mcp }) } }, null))
    expect(inspectMcpEntry(opencode, 'opencode', { entry: mcp })).toBe('yes')

    const plist = plistContent({ mode, dataDir: DATA_DIR, homeDir: HOME, pathEnv: '/usr/bin:/bin' })
    expect(plist).toContain(`<array><string>${PROGRAM}</string><string>--data-dir</string><string>${DATA_DIR}</string><string>daemon</string></array>`)
    expect(plist).toContain(`<key>KINFOLD_DATA_DIR</key><string>${DATA_DIR}</string>`)

    const written = samCommand({ entry: entryCommand(mode, 'hook', DATA_DIR, 'codex') }, 'codex')
    expect(written).toBe(`'${PROGRAM}' --data-dir '${DATA_DIR}' hook --host codex`)
    expect(samCommandScript({ command: written }, 'codex')).toBe(PROGRAM)
  })
})
