import { afterEach, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { windowsOnly } from '../../test/platform-guards'
import { EXIT_OK } from './install'
import { leftBehindLine } from './program-files'
import { type ProgramFsDeps, OLD_PROGRAM_PREFIX, createWindowsProgramFiles, windowsProgramFiles } from './program-files-windows'
import { type FakeWorld, createWorld } from './test-support'
import { uninstall } from './uninstall'

let world: FakeWorld | null = null
let child: { kill(): void; exited: Promise<number> } | null = null
afterEach(async () => {
  if (child !== null) {
    child.kill()
    await child.exited
  }
  child = null
  await world?.cleanup()
  world = null
})

function fsError(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: fake`), { code })
}

interface FakeFsOptions {
  /** An error a rename throws before it would happen. */
  renameError?: (from: string, to: string) => NodeJS.ErrnoException | null
  /** An error a remove throws before it would happen. */
  rmError?: (path: string) => NodeJS.ErrnoException | null
}

interface FakeFs {
  files: Set<string>
  renames: Array<[string, string]>
  removed: string[]
  deps: Partial<ProgramFsDeps>
}

/** A folder of names. A rename onto an existing file fails, as Windows refuses to replace a running image. */
function fakeFs(initial: string[], options: FakeFsOptions = {}): FakeFs {
  const files = new Set(initial)
  const renames: Array<[string, string]> = []
  const removed: string[] = []
  const renameSync = (from: string, to: string): void => {
    renames.push([from, to])
    const error = options.renameError?.(from, to) ?? (files.has(to) ? fsError('EPERM') : files.has(from) ? null : fsError('ENOENT'))
    if (error !== null) throw error
    files.delete(from)
    files.add(to)
  }
  const rmSync = (path: string): void => {
    const error = options.rmError?.(path) ?? null
    if (error !== null) throw error
    removed.push(path)
    for (const file of [...files]) if (file === path || file.startsWith(`${path}\\`)) files.delete(file)
  }
  const deps: Partial<ProgramFsDeps> = {
    renameSync: renameSync as ProgramFsDeps['renameSync'],
    rmSync: rmSync as ProgramFsDeps['rmSync'],
    readdirSync: (dir) => [...files].filter((f) => f.startsWith(`${dir}\\`)).map((f) => f.slice(dir.length + 1)),
    existsSync: (path) => files.has(path) || [...files].some((f) => f.startsWith(`${path}\\`)),
    pid: 7,
    now: () => 1000,
  }
  return { files, renames, removed, deps }
}

const DIR = 'C:\\d\\bin'
const TARGET = `${DIR}\\kinfold.exe`
const TEMP = `${DIR}\\kinfold.exe.tmp-1`
const OLD = `${DIR}\\${OLD_PROGRAM_PREFIX}7-1000.exe`

test('a running program is moved aside, not overwritten', () => {
  // The moved-aside program is still running, so its cleanup is refused. Bun on Windows says EFAULT for that.
  const fs = fakeFs([TARGET, TEMP], { rmError: (path) => (path === OLD ? fsError('EFAULT') : null) })
  createWindowsProgramFiles(fs.deps).replace(TEMP, TARGET)
  expect(fs.renames).toEqual([[TARGET, OLD], [TEMP, TARGET]])
  expect([...fs.files].sort()).toEqual([OLD, TARGET].sort())
})

test('a first install has nothing to move aside', () => {
  const fs = fakeFs([TEMP])
  createWindowsProgramFiles(fs.deps).replace(TEMP, TARGET)
  expect(fs.renames).toEqual([[TEMP, TARGET]])
})

test('a failure between the move and the install puts kinfold.exe back and keeps the old copies', () => {
  const older = `${DIR}\\${OLD_PROGRAM_PREFIX}3-10.exe`
  const fs = fakeFs([TARGET, TEMP, older], { renameError: (from) => (from === TEMP ? fsError('EIO') : null) })
  expect(() => createWindowsProgramFiles(fs.deps).replace(TEMP, TARGET)).toThrow('EIO')
  expect(fs.renames).toEqual([[TARGET, OLD], [TEMP, TARGET], [OLD, TARGET]])
  expect(fs.files.has(TARGET)).toBe(true)
  expect(fs.files.has(OLD)).toBe(false)
  expect(fs.files.has(older)).toBe(true)
  expect(fs.removed).toEqual([])
})

test('a rollback that throws still reports the swap error', () => {
  const fs = fakeFs([TARGET, TEMP], {
    renameError: (from) => (from === TEMP ? fsError('EIO') : from === OLD ? fsError('EACCES') : null),
  })
  expect(() => createWindowsProgramFiles(fs.deps).replace(TEMP, TARGET)).toThrow('EIO: fake')
  expect(fs.renames).toEqual([[TARGET, OLD], [TEMP, TARGET], [OLD, TARGET]])
  // The aside copy is the only program now; the next replace restores it.
  expect(fs.files.has(OLD)).toBe(true)
})

test('the run after a crash restores the newest old program and never deletes the only copy', () => {
  // A crash between the move and the install left no kinfold.exe, only old names.
  const oldest = `${DIR}\\${OLD_PROGRAM_PREFIX}9-500.exe`
  const newest = `${DIR}\\${OLD_PROGRAM_PREFIX}3-900.exe`
  const failing = fakeFs([TEMP, oldest, newest], { renameError: (from) => (from === TEMP ? fsError('EIO') : null) })
  expect(() => createWindowsProgramFiles(failing.deps).replace(TEMP, TARGET)).toThrow('EIO')
  expect(failing.renames[0]).toEqual([newest, TARGET])
  expect(failing.files.has(TARGET)).toBe(true)
  expect(failing.files.has(oldest)).toBe(true)
  expect(failing.removed).toEqual([])

  const fs = fakeFs([TEMP, oldest, newest])
  createWindowsProgramFiles(fs.deps).replace(TEMP, TARGET)
  expect(fs.renames).toEqual([[newest, TARGET], [TARGET, OLD], [TEMP, TARGET]])
  expect([...fs.files]).toEqual([TARGET])
})

test('old programs still running are left for later', () => {
  const busy = `${DIR}\\${OLD_PROGRAM_PREFIX}3-10.exe`
  const done = `${DIR}\\${OLD_PROGRAM_PREFIX}4-20.exe`
  const fs = fakeFs([TARGET, TEMP, busy, done], { rmError: (path) => (path === busy ? fsError('EBUSY') : null) })
  expect(() => createWindowsProgramFiles(fs.deps).replace(TEMP, TARGET)).not.toThrow()
  expect(fs.removed.sort()).toEqual([done, OLD].sort())
  expect(fs.files.has(busy)).toBe(true)
  expect(fs.files.has(TARGET)).toBe(true)
})

test('old programs are removed only after the new one is in place', () => {
  const stale = `${DIR}\\${OLD_PROGRAM_PREFIX}3-10.exe`
  const fs = fakeFs([TARGET, TEMP, stale], { rmError: () => fsError('EIO') })
  // A cleanup error that is not a lock is still reported, but the swap already happened.
  expect(() => createWindowsProgramFiles(fs.deps).replace(TEMP, TARGET)).toThrow('EIO')
  expect(fs.renames).toEqual([[TARGET, OLD], [TEMP, TARGET]])
  expect(fs.files.has(TARGET)).toBe(true)
})

test('removeBinDir renames a locked program aside, returns it and keeps the folder', () => {
  const lib = `${DIR}\\helper.dll`
  const fs = fakeFs([TARGET, lib], { rmError: (path) => (path === TARGET ? fsError('EPERM') : null) })
  expect(createWindowsProgramFiles(fs.deps).removeBinDir(DIR)).toEqual([OLD])
  expect(fs.removed).toEqual([lib])
  expect(fs.files.has(OLD)).toBe(true)
})

test('removeBinDir keeps a name already moved aside', () => {
  const fs = fakeFs([OLD], { rmError: (path) => (path === OLD ? fsError('EACCES') : null) })
  expect(createWindowsProgramFiles(fs.deps).removeBinDir(DIR)).toEqual([OLD])
  expect(fs.renames).toEqual([])
})

test('removeBinDir removes the folder once nothing in it is locked', () => {
  const fs = fakeFs([TARGET])
  expect(createWindowsProgramFiles(fs.deps).removeBinDir(DIR)).toEqual([])
  expect(fs.removed).toEqual([TARGET, DIR])
})

test('removeBinDir on a missing folder leaves nothing', () => {
  const fs = fakeFs([])
  expect(createWindowsProgramFiles(fs.deps).removeBinDir(DIR)).toEqual([])
  expect(fs.removed).toEqual([])
})

const sha256 = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex')

windowsOnly('running image')('update replaces a program another process is running', async () => {
  const w = createWorld({ platform: 'win32' })
  world = w
  const bin = join(w.dataDir, 'bin')
  mkdirSync(bin, { recursive: true })
  const target = join(bin, 'kinfold.exe')
  copyFileSync(process.execPath, target)
  const running = Bun.spawn([target, '-e', 'setTimeout(() => {}, 20000)'], { stdout: 'ignore', stderr: 'ignore' })
  child = running
  // The image is mapped once the process has started; a short wait makes sure.
  await Bun.sleep(500)
  expect(running.exitCode).toBeNull()

  const next = join(bin, 'kinfold.exe.new')
  copyFileSync(process.execPath, next)
  // Trailing bytes make the new copy's hash differ from the running one's.
  appendFileSync(next, 'kinfold-next')
  const nextHash = sha256(next)
  windowsProgramFiles.replace(next, target)
  expect(sha256(target)).toBe(nextHash)
  expect(running.exitCode).toBeNull()
  const aside = readdirSync(bin).filter((name) => name.startsWith(OLD_PROGRAM_PREFIX))
  expect(aside).toHaveLength(1)
  const asidePath = join(bin, aside[0]!)

  let left: string[] = []
  expect(() => {
    left = windowsProgramFiles.removeBinDir(bin)
  }).not.toThrow()
  expect(left).toEqual([asidePath])
  expect(existsSync(target)).toBe(false)

  w.out.length = 0
  const env = { ...w.env, platform: 'win32' as const, service: null }
  expect(await uninstall(env, { dryRun: false, removeCredentials: false })).toBe(EXIT_OK)
  expect(w.out).toContain(leftBehindLine(asidePath))
  expect(running.exitCode).toBeNull()
}, 30000)
