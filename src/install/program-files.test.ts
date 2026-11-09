import { afterEach, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { detectPlatform } from '../platform/platform'
import { type ProgramFiles, leftBehindLine, posixProgramFiles, programFilesFor, programFilesOf } from './program-files'
import { windowsProgramFiles } from './program-files-windows'
import { createWorld, type FakeWorld } from './test-support'

let root: string | null = null
let world: FakeWorld | null = null
afterEach(async () => {
  if (root !== null) rmSync(root, { recursive: true, force: true })
  root = null
  await world?.cleanup()
  world = null
})

const platform = (name: NodeJS.Platform, wsl = false) => detectPlatform({ platform: name, osRelease: () => null, env: wsl ? { WSL_DISTRO_NAME: 'Ubuntu' } : {} })

test('each platform gets its own program files', () => {
  expect(programFilesFor(platform('win32'))).toBe(windowsProgramFiles)
  expect(programFilesFor(platform('darwin'))).toBe(posixProgramFiles)
  expect(programFilesFor(platform('linux'))).toBe(posixProgramFiles)
  expect(programFilesFor(platform('linux', true))).toBe(posixProgramFiles)
})

test('an env with its own program files uses them, else its platform\'s', () => {
  world = createWorld()
  const own: ProgramFiles = { replace: () => {}, removeBinDir: () => [] }
  expect(programFilesOf(world.env)).toBe(posixProgramFiles)
  expect(programFilesOf({ ...world.env, platform: 'win32' })).toBe(windowsProgramFiles)
  expect(programFilesOf({ ...world.env, programFiles: own })).toBe(own)
})

test('the POSIX program files rename into place and remove the whole bin folder', () => {
  root = mkdtempSync(join(tmpdir(), 'kinfold-program-files-'))
  const bin = join(root, 'bin')
  mkdirSync(bin)
  writeFileSync(join(bin, 'kinfold'), 'old\n')
  writeFileSync(join(bin, '.tmp'), 'new\n')
  posixProgramFiles.replace(join(bin, '.tmp'), join(bin, 'kinfold'))
  expect(readFileSync(join(bin, 'kinfold'), 'utf8')).toBe('new\n')
  expect(existsSync(join(bin, '.tmp'))).toBe(false)
  expect(posixProgramFiles.removeBinDir(bin)).toEqual([])
  expect(existsSync(bin)).toBe(false)
  expect(posixProgramFiles.removeBinDir(bin)).toEqual([])
})

test('a file left behind is named with what still holds it', () => {
  expect(leftBehindLine('/d/bin/.kinfold-old-1')).toBe('uninstall: could not remove /d/bin/.kinfold-old-1; a running kinfold (an agent session\'s MCP server) still uses it. Remove it after closing those sessions')
})
