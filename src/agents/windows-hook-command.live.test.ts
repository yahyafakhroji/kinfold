// The hook command an install writes on Windows, run through the real
// shells. Runs only with KINFOLD_TEST_WINDOWS_HOOK_SHELL=1 on the Windows
// smoke runner. For each agent whose Windows shell is known, the install plan
// is written into a temp home, the command is read back out of the config
// file, and that exact string goes through the shell the way the agent
// starts it. A stub kinfold.exe records the arguments and the stdin it got.
// The stub sits in a folder whose name holds every character one of the
// shells treats specially, so the quoting is what is under test.
// How each agent starts its shell, from the sources the profiles cite:
//   Copilot, Cursor: PowerShell; neither says which, so both are run
//   Gemini CLI: pwsh or powershell.exe -NoProfile -NonInteractive -Command,
//     with an exit-code check appended to the command
//   Qwen Code: powershell -Command, for an entry whose shell is powershell
//   Junie: cmd /c; the JVM passes the line bare or inside one pair of quotes
//   Codex: %COMSPEC% /C "<command>"
// Node's own shell form, cmd /d /s /c "<command>", is run for both cmd agents
// too, since an agent built on Node would use it.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { InstallEnv } from '../install/env'
import { type FakeWorld, createWorld } from '../install/test-support'
import { currentPlatform } from '../platform/platform'
import { profileOf } from './install-profiles'
import type { AgentId } from './profile'

const LIVE = currentPlatform().os === 'windows' && process.env.KINFOLD_TEST_WINDOWS_HOOK_SHELL === '1'

/** A space, an apostrophe, a curly quote, &, ^, a lone % and a real variable name between two, and non-ASCII letters. */
const AWKWARD_FOLDER = "O'Brien & Co 100% %TEMP% a^b it’s données 山田"

const STUB_SOURCE = `
import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
const stdin = await Bun.stdin.text()
writeFileSync(join(dirname(process.execPath), 'argv.json'), JSON.stringify({ argv: process.argv.slice(2), stdin }))
`

const PAYLOAD = JSON.stringify({ hook_event_name: 'Stop', note: 'héllo "quoted" 山田' })
const GEMINI_EXIT_CHECK = '; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }'

interface Run {
  name: string
  file: string
  args: string[]
  /** The arguments are the command line as given, with no quoting added. */
  verbatim?: boolean
}

const powershells = (): string[] => ['powershell.exe', ...(Bun.which('pwsh.exe') !== null ? ['pwsh.exe'] : [])]
const comspec = (): string => process.env.ComSpec ?? 'cmd.exe'

const RUNS: Readonly<Partial<Record<AgentId, (command: string) => Run[]>>> = {
  copilot: (command) => powershells().map((file) => ({ name: file, file, args: ['-NoProfile', '-Command', command] })),
  cursor: (command) => powershells().map((file) => ({ name: file, file, args: ['-NoProfile', '-Command', command] })),
  'gemini-cli': (command) => powershells().map((file) => ({ name: file, file, args: ['-NoProfile', '-NonInteractive', '-Command', `${command}${GEMINI_EXIT_CHECK}`] })),
  'qwen-code': (command) => [{ name: 'powershell -Command', file: 'powershell', args: ['-Command', command] }],
  junie: (command) => [
    { name: 'cmd /c <command>', file: comspec(), args: ['/c', command], verbatim: true },
    { name: 'cmd /c "<command>"', file: comspec(), args: ['/c', `"${command}"`], verbatim: true },
    { name: 'cmd /d /s /c "<command>"', file: comspec(), args: ['/d', '/s', '/c', `"${command}"`], verbatim: true },
  ],
  codex: (command) => [
    { name: 'COMSPEC /C "<command>"', file: comspec(), args: ['/C', `"${command}"`], verbatim: true },
    { name: 'cmd /d /s /c "<command>"', file: comspec(), args: ['/d', '/s', '/c', `"${command}"`], verbatim: true },
  ],
}

/** Every hook entry in a config: an object whose `command` string runs the stub. */
function hookEntries(value: unknown, found: Record<string, unknown>[] = []): Record<string, unknown>[] {
  if (Array.isArray(value)) for (const item of value) hookEntries(item, found)
  else if (typeof value === 'object' && value !== null) {
    const entry = value as Record<string, unknown>
    if (typeof entry.command === 'string' && entry.command.includes('kinfold.exe') && entry.command.includes(' hook ')) found.push(entry)
    else for (const item of Object.values(entry)) hookEntries(item, found)
  }
  return found
}

describe.skipIf(!LIVE)('hook commands through the Windows shells (live)', () => {
  let root = ''
  let dataDir = ''
  let program = ''
  let recorded = ''
  let world: FakeWorld | null = null

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'kinfold-hook-shell-'))
    dataDir = join(root, AWKWARD_FOLDER, 'My Memory')
    program = join(dataDir, 'bin', 'kinfold.exe')
    recorded = join(dataDir, 'bin', 'argv.json')
    mkdirSync(dirname(program), { recursive: true })
    // Built at a plain path and copied in, so the build itself never meets the folder name.
    const source = join(root, 'stub.ts')
    const built = join(root, 'stub.exe')
    writeFileSync(source, STUB_SOURCE)
    const build = spawnSync(process.execPath, ['build', '--compile', source, '--outfile', built], { cwd: root, encoding: 'utf8' })
    if (build.status !== 0 || !existsSync(built)) throw new Error(`the stub did not build: ${build.stdout}${build.stderr}`)
    copyFileSync(built, program)
    world = createWorld({ platform: 'win32' })
  }, 180_000)

  afterAll(async () => {
    await world?.cleanup()
    if (root !== '') rmSync(root, { recursive: true, force: true })
  })

  /** The hook entries an install writes for `id`, read back from the config file they were written to. */
  async function writtenEntries(id: AgentId): Promise<Record<string, unknown>[]> {
    if (world === null) throw new Error('no world')
    const env: InstallEnv = { ...world.env, dataDir, mode: { kind: 'program', binPath: program } }
    for (const action of await profileOf(id).wiring.install(env)) {
      if (action.kind !== 'write') continue
      expect(action.path.startsWith(env.homeDir)).toBe(true)
      mkdirSync(dirname(action.path), { recursive: true })
      writeFileSync(action.path, action.content)
      const entries = hookEntries(JSON.parse(readFileSync(action.path, 'utf8')))
      if (entries.length > 0) return entries
    }
    throw new Error(`${id}: the install wrote no hook command`)
  }

  for (const id of Object.keys(RUNS) as AgentId[]) {
    test(`${id}: the written command reaches the program with its exact arguments and stdin`, async () => {
      const entries = await writtenEntries(id)
      const commands = [...new Set(entries.map((entry) => entry.command as string))]
      // One string for every event, so one run proves them all.
      expect(commands).toHaveLength(1)
      const command = commands[0] ?? ''
      // Qwen Code's default shell on Windows depends on the terminal, so every entry names PowerShell.
      if (id === 'qwen-code') expect(entries.map((entry) => entry.shell)).toEqual(entries.map(() => 'powershell'))
      const runs = RUNS[id]?.(command) ?? []
      expect(runs.length).toBeGreaterThan(0)
      // Every run is made before any is judged, so one failure still shows how the others went.
      const results = runs.map((run) => {
        rmSync(recorded, { force: true })
        const result = spawnSync(run.file, run.args, { input: PAYLOAD, encoding: 'utf8', windowsVerbatimArguments: run.verbatim === true, timeout: 60_000 })
        const seen = existsSync(recorded) ? JSON.parse(readFileSync(recorded, 'utf8')) : null
        return { run: run.name, command, status: result.status, stderr: result.stderr, seen }
      })
      expect(results).toEqual(
        runs.map((run) => ({ run: run.name, command, status: 0, stderr: '', seen: { argv: ['--data-dir', dataDir, 'hook', '--host', id], stdin: PAYLOAD } })),
      )
    }, 180_000)
  }
})
