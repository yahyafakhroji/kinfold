import { fakeTerminal } from '../install/prompt/fake-terminal'
import { runFramed } from '../install/prompt/frame'
import { afterEach, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, fstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { installedProgramPath } from '../install/entry'
import { installProgram, releaseAssetName } from '../install/self-install'
import { type FakeService, type FakeWorld, countingService, createWorld, fakeService } from '../install/test-support'
import type { ServiceControl } from '../install/service/control'
import { StubService } from '../install/service/stub-service'
import { mergeAutoState, readAutoState } from './auto-state'
import { LATEST_RELEASE_URL } from './check'
import { UPDATE_LOCK_FILE, acquireUpdateLock, updateLockHolder } from './lock'
import { writeUpdateState } from './state'
import { QUIET_MS } from './auto'
import { AUTO_INSTALL_TIMEOUT_MS, AUTO_LOG_KEEP_BYTES, AUTO_LOG_MAX_BYTES, QUIET_WAIT_CAP_MS, programUrl, runUpdate , captureProgram } from './update'
import { posixOnly } from '../../test/platform-guards'

const ARCH = 'arm64'
const ASSET = releaseAssetName('darwin', ARCH)!
const NEW_PROGRAM = 'kinfold program v0.2.0\n'
const OLD_PROGRAM = 'kinfold program v0.1.0\n'
const SUMS_URL = 'https://github.com/yahyafakhroji/kinfold/releases/download/v0.2.0/SHA256SUMS'
const PROGRAM_URL = programUrl('0.2.0', ASSET)

let world: FakeWorld | null = null
afterEach(async () => {
  await world?.cleanup()
  world = null
})

function sha(bytes: string | Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

interface Release {
  tag?: string
  sums?: string
  program?: () => Response
}

interface UpdateWorld {
  w: FakeWorld
  binPath: string
  service: FakeService
  fetched: string[]
}

/** A program install of 0.1.0 whose fetch answers only the release JSON, the checksums and the program. */
function updateWorld(release: Release = {}, mode: 'program' | 'checkout' = 'program'): UpdateWorld {
  const w = createWorld()
  world = w
  const binPath = installedProgramPath(w.dataDir, 'darwin')
  mkdirSync(dirname(binPath), { recursive: true, mode: 0o700 })
  writeFileSync(binPath, OLD_PROGRAM, { mode: 0o755 })
  const service = fakeService()
  const fetched: string[] = []
  const tag = release.tag ?? 'v0.2.0'
  const answers: Record<string, () => Response> = {
    [LATEST_RELEASE_URL]: () => new Response(JSON.stringify({ tag_name: tag, draft: false, prerelease: false })),
    [SUMS_URL.replace('v0.2.0', tag)]: () => new Response(release.sums ?? `${sha(NEW_PROGRAM)}  ${ASSET}\n`),
    [programUrl(tag.slice(1), ASSET)]: release.program ?? (() => new Response(NEW_PROGRAM)),
  }
  w.env = {
    ...w.env,
    arch: ARCH,
    mode: mode === 'program' ? { kind: 'program', binPath } : w.env.mode,
    service,
    envVars: { PATH: '/usr/bin', HOME: w.home },
    fetch: async (url) => {
      fetched.push(url)
      const answer = answers[url]
      if (answer === undefined) throw new TypeError('connection refused (test world)')
      return answer()
    },
  }
  return { w, binPath, service, fetched }
}

function tempFiles(binPath: string): string[] {
  return readdirSync(dirname(binPath)).filter((name) => name.startsWith('.kinfold-update-'))
}

function noRun(): never {
  throw new Error('runProgram must not be called')
}

test('refuses on a checkout install', async () => {
  const { w, fetched } = updateWorld({}, 'checkout')
  expect(await runUpdate(w.env, { dryRun: false }, { version: '0.1.0', runProgram: noRun })).toBe(1)
  expect(w.out).toEqual(['kinfold update: this is a checkout install; update it with git pull and bun src/cli/kinfold.ts install'])
  expect(fetched).toEqual([])
})

test('up to date does nothing', async () => {
  const { w, binPath, fetched, service } = updateWorld({ tag: 'v0.1.0' })
  expect(await runUpdate(w.env, { dryRun: false }, { version: '0.1.0', runProgram: noRun })).toBe(0)
  expect(w.out).toEqual(['kinfold is up to date (0.1.0)'])
  expect(fetched).toEqual([LATEST_RELEASE_URL])
  expect(readFileSync(binPath, 'utf8')).toBe(OLD_PROGRAM)
  expect(service.calls).toEqual([])
})

test('a hash mismatch changes nothing', async () => {
  const { w, binPath, service } = updateWorld({ program: () => new Response('kinfold program, tampered\n') })
  let ran = false
  const code = await runUpdate(w.env, { dryRun: false }, { version: '0.1.0', runProgram: async () => ((ran = true), 0) })
  expect(code).toBe(1)
  expect(w.out).toContain('kinfold update: the downloaded program does not match the release checksums; nothing was changed')
  expect(readFileSync(binPath, 'utf8')).toBe(OLD_PROGRAM)
  expect(tempFiles(binPath)).toEqual([])
  expect(ran).toBe(false)
  expect(service.calls).toEqual([])
})

test('a cut-off download leaves the old program running', async () => {
  const half = new TextEncoder().encode(NEW_PROGRAM.slice(0, 10))
  const cutOff = (): Response => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(half)
      controller.error(new TypeError('connection reset'))
    },
  }))
  const { w, binPath, service } = updateWorld({ program: cutOff })
  const code = await runUpdate(w.env, { dryRun: false }, { version: '0.1.0', runProgram: noRun })
  expect(code).toBe(1)
  expect(w.out.at(-1)).toBe('kinfold update: the program download was cut off (TypeError); nothing was changed')
  expect(tempFiles(binPath)).toEqual([])
  expect(readFileSync(binPath, 'utf8')).toBe(OLD_PROGRAM)
  expect(service.calls).toEqual([])
})

test('a truncated download leaves the old program running', async () => {
  const { w, binPath, service } = updateWorld({ program: () => new Response(NEW_PROGRAM.slice(0, 10)) })
  expect(await runUpdate(w.env, { dryRun: false }, { version: '0.1.0', runProgram: noRun })).toBe(1)
  expect(w.out.at(-1)).toBe('kinfold update: the downloaded program does not match the release checksums; nothing was changed')
  expect(tempFiles(binPath)).toEqual([])
  expect(readFileSync(binPath, 'utf8')).toBe(OLD_PROGRAM)
  expect(service.calls).toEqual([])
})

test('the folder is flushed after the program rename', async () => {
  const { w, binPath } = updateWorld()
  const source = join(w.root, 'kinfold-build')
  writeFileSync(source, NEW_PROGRAM, { mode: 0o755 })
  const action = { kind: 'install-program', from: source, to: binPath, assetName: ASSET, expectedSha256: sha(NEW_PROGRAM), check: true } as const
  const synced: { ino: number; program: string }[] = []
  const spy = (fd: number): void => {
    synced.push({ ino: fstatSync(fd).ino, program: readFileSync(binPath, 'utf8') })
  }
  await installProgram({ ...w.env, fsyncDir: spy }, action)
  expect(synced).toEqual([{ ino: statSync(dirname(binPath)).ino, program: NEW_PROGRAM }])

  writeFileSync(binPath, OLD_PROGRAM, { mode: 0o755 })
  synced.length = 0
  await installProgram({ ...w.env, platform: 'win32', fsyncDir: spy }, action)
  expect(readFileSync(binPath, 'utf8')).toBe(NEW_PROGRAM)
  expect(synced).toEqual([])
})

posixOnly('file modes')('a verified program is handed install --yes with the saved channel', async () => {
  const { w, binPath, service } = updateWorld()
  writeFileSync(join(w.dataDir, 'install.json'), JSON.stringify({ channel: 'npx', updateCheck: true, firstInstalledAt: 1 }))
  const calls: { path: string; argv: readonly string[]; env: Readonly<Record<string, string>>; bytes: string; mode: number }[] = []
  const code = await runUpdate(w.env, { dryRun: false }, {
    version: '0.1.0',
    runProgram: async (path, argv, env) => {
      calls.push({ path, argv, env, bytes: readFileSync(path, 'utf8'), mode: statSync(path).mode & 0o777 })
      writeFileSync(binPath, readFileSync(path))
      return 0
    },
  })
  expect(code).toBe(0)
  expect(calls).toHaveLength(1)
  const call = calls[0]!
  expect(dirname(call.path)).toBe(dirname(binPath))
  expect(call.path.startsWith(join(dirname(binPath), '.kinfold-update-'))).toBe(true)
  expect(call.argv).toEqual(['--data-dir', w.dataDir, 'install', '--yes'])
  expect(call.env.KINFOLD_INSTALL_CHANNEL).toBe('npx')
  expect(call.env.PATH).toBe('/usr/bin')
  expect(call.bytes).toBe(NEW_PROGRAM)
  expect(call.mode).toBe(0o700)
  expect(existsSync(call.path)).toBe(false)
  expect(tempFiles(binPath)).toEqual([])
  expect(w.out.at(-1)).toBe('kinfold updated to 0.2.0')
  // The service is the child install's to stop and start, never this process's.
  expect(service.calls.filter((call) => call === 'start' || call === 'stop')).toEqual([])
})

test('a failed hand-off says the old program is still in place', async () => {
  const { w, binPath } = updateWorld()
  const code = await runUpdate(w.env, { dryRun: false }, { version: '0.1.0', runProgram: async () => 3 })
  expect(code).toBe(1)
  expect(w.out.at(-1)).toBe(`kinfold update: the new program's install stopped (exit 3); ${binPath} is still 0.1.0; the service is running`)
  expect(readFileSync(binPath, 'utf8')).toBe(OLD_PROGRAM)
  expect(tempFiles(binPath)).toEqual([])
})

test('--dry-run downloads nothing', async () => {
  const { w, binPath, fetched, service } = updateWorld()
  expect(await runUpdate(w.env, { dryRun: true }, { version: '0.1.0', runProgram: noRun })).toBe(0)
  expect(fetched).toEqual([LATEST_RELEASE_URL])
  const text = w.out.join('\n')
  expect(text).toContain('0.2.0')
  expect(text).toContain(SUMS_URL)
  expect(text).toContain(PROGRAM_URL)
  expect(text).toContain('install --yes')
  expect(tempFiles(binPath)).toEqual([])
  expect(readFileSync(binPath, 'utf8')).toBe(OLD_PROGRAM)
  expect(service.calls).toEqual([])
})

test('the download stops at the size cap', async () => {
  const big = 'x'.repeat(64)
  let pulled = 0
  const endless = (): Response => new Response(new ReadableStream({
    pull(controller) {
      pulled += 1
      controller.enqueue(new TextEncoder().encode(big))
    },
  }))
  const { w, binPath } = updateWorld({ program: endless })
  const code = await runUpdate(w.env, { dryRun: false }, { version: '0.1.0', maxProgramBytes: 1000, runProgram: noRun })
  expect(code).toBe(1)
  expect(w.out.at(-1)).toBe('kinfold update: the program download is far larger than a release build; nothing was changed')
  expect(pulled).toBeLessThan(40)
  expect(tempFiles(binPath)).toEqual([])
  expect(readFileSync(binPath, 'utf8')).toBe(OLD_PROGRAM)
})

test('a declared size over the cap is refused before reading', async () => {
  const { w, binPath } = updateWorld({ program: () => new Response(NEW_PROGRAM, { headers: { 'content-length': '300000001' } }) })
  expect(await runUpdate(w.env, { dryRun: false }, { version: '0.1.0', runProgram: noRun })).toBe(1)
  expect(w.out.at(-1)).toBe('kinfold update: the program download is far larger than a release build; nothing was changed')
  expect(tempFiles(binPath)).toEqual([])
})

test('a release without this platform in SHA256SUMS changes nothing', async () => {
  const { w, binPath } = updateWorld({ sums: `${sha(NEW_PROGRAM)}  kinfold-linux-x64\n` })
  expect(await runUpdate(w.env, { dryRun: false }, { version: '0.1.0', runProgram: noRun })).toBe(1)
  expect(w.out.at(-1)).toBe(`kinfold update: SHA256SUMS has no entry for ${ASSET}; nothing was changed`)
  expect(tempFiles(binPath)).toEqual([])
  expect(readFileSync(binPath, 'utf8')).toBe(OLD_PROGRAM)
})

test('an unreachable release API says why and changes nothing', async () => {
  const { w, binPath } = updateWorld()
  w.env = { ...w.env, fetch: async () => new Response('', { status: 403 }) }
  expect(await runUpdate(w.env, { dryRun: false }, { version: '0.1.0', runProgram: noRun })).toBe(1)
  expect(w.out.at(-1)).toBe('kinfold update: could not ask GitHub for the latest release (403)')
  expect(readFileSync(binPath, 'utf8')).toBe(OLD_PROGRAM)
})

test('a failed hand-off that left the service stopped says so', async () => {
  const { w, binPath } = updateWorld()
  const stopped = fakeService({ running: false })
  w.env = { ...w.env, service: stopped }
  expect(await runUpdate(w.env, { dryRun: false }, { version: '0.1.0', runProgram: async () => 4 })).toBe(1)
  expect(w.out.at(-1)).toBe(`kinfold update: the new program's install stopped (exit 4); ${binPath} is still 0.1.0; the service is stopped; kinfold install starts it again`)
  // Stopped before the hand-off too, so it is not this process's to start.
  expect(stopped.calls.filter((call) => call === 'start' || call === 'stop')).toEqual([])
})

/** A pid that existed and has exited: a short child, waited for. */
async function deadPid(): Promise<number> {
  const child = Bun.spawn(['/bin/sh', '-c', 'exit 0'], { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' })
  await child.exited
  return child.pid
}

async function plantLeftovers(binPath: string): Promise<{ dead: string; deadExe: string; live: string; other: string }> {
  const bin = dirname(binPath)
  const paths = {
    dead: join(bin, `.kinfold-update-${await deadPid()}`),
    deadExe: join(bin, `.kinfold-update-${await deadPid()}.exe`),
    live: join(bin, `.kinfold-update-${process.ppid}`),
    other: join(bin, '.kinfold-update-notapid'),
  }
  for (const path of Object.values(paths)) writeFileSync(path, 'partial program')
  return paths
}

posixOnly('sh scripts')("leftovers of dead update runs are swept, a live run's file is kept", async () => {
  const { w, binPath } = updateWorld({ tag: 'v0.1.0' })
  const { dead, deadExe, live, other } = await plantLeftovers(binPath)
  expect(await runUpdate(w.env, { dryRun: false }, { version: '0.1.0', runProgram: noRun })).toBe(0)
  expect(existsSync(dead)).toBe(false)
  expect(existsSync(deadExe)).toBe(false)
  expect(existsSync(live)).toBe(true)
  expect(existsSync(other)).toBe(true)
  expect(readFileSync(binPath, 'utf8')).toBe(OLD_PROGRAM)
  expect(w.out).toEqual(['kinfold is up to date (0.1.0)'])
})

posixOnly('sh scripts')('a dry run lists dead leftovers by name and removes nothing', async () => {
  const { w, binPath } = updateWorld()
  const paths = await plantLeftovers(binPath)
  expect(await runUpdate(w.env, { dryRun: true }, { version: '0.1.0', runProgram: noRun })).toBe(0)
  for (const path of Object.values(paths)) expect(existsSync(path)).toBe(true)
  expect(w.out[0]).toBe('kinfold update: 0.1.0 -> 0.2.0 (dry run; nothing is downloaded or changed)')
  const line = w.out.find((entry) => entry.startsWith('  0. remove what earlier update runs left in '))
  expect(line).toBeDefined()
  expect(line).toContain(basename(paths.dead))
  expect(line).toContain(basename(paths.deadExe))
  expect(line).not.toContain(basename(paths.live))
  expect(line).not.toContain(basename(paths.other))
})

posixOnly('sh scripts')('a folder with a temp name is skipped, and an unremovable leftover is named, not fatal', async () => {
  const { w, binPath } = updateWorld({ tag: 'v0.1.0' })
  const bin = dirname(binPath)
  const folder = join(bin, `.kinfold-update-${await deadPid()}`)
  mkdirSync(folder)
  writeFileSync(join(folder, 'inside'), 'x')
  const stuck = join(bin, `.kinfold-update-${await deadPid()}`)
  writeFileSync(stuck, 'partial program')
  chmodSync(bin, 0o500)
  let code: number
  try {
    code = await runUpdate(w.env, { dryRun: false }, { version: '0.1.0', runProgram: noRun })
  } finally {
    chmodSync(bin, 0o700)
  }
  expect(code).toBe(0)
  expect(existsSync(join(folder, 'inside'))).toBe(true)
  expect(existsSync(stuck)).toBe(true)
  expect(w.out).toEqual([`kinfold update: could not remove ${stuck}, left by an earlier update (EACCES); remove it by hand`, 'kinfold is up to date (0.1.0)'])
})

test('a file or link already at the temp name is refused, not followed or removed', async () => {
  const { w, binPath } = updateWorld()
  const target = join(w.root, 'elsewhere')
  writeFileSync(target, 'not kinfold')
  const temp = join(dirname(binPath), `.kinfold-update-${process.pid}`)
  symlinkSync(target, temp)
  expect(await runUpdate(w.env, { dryRun: false }, { version: '0.1.0', runProgram: noRun })).toBe(1)
  expect(w.out.at(-1)).toBe(`kinfold update: ${temp} already exists; remove it and run kinfold update again; nothing was changed`)
  expect(readFileSync(target, 'utf8')).toBe('not kinfold')
  expect(readlinkSync(temp)).toBe(target)
  expect(readFileSync(binPath, 'utf8')).toBe(OLD_PROGRAM)
})

posixOnly('file modes')('a write error before the hand-off says nothing was changed', async () => {
  const { w, binPath, service } = updateWorld()
  chmodSync(dirname(binPath), 0o500)
  try {
    expect(await runUpdate(w.env, { dryRun: false }, { version: '0.1.0', runProgram: noRun })).toBe(1)
  } finally {
    chmodSync(dirname(binPath), 0o700)
  }
  expect(w.out.at(-1)).toBe('kinfold update: could not write the download (EACCES); nothing was changed')
  expect(tempFiles(binPath)).toEqual([])
  expect(readFileSync(binPath, 'utf8')).toBe(OLD_PROGRAM)
  expect(service.calls).toEqual([])
})

test('a hand-off killed while the child had the service stopped starts it again from the parent', async () => {
  const { w, binPath, service } = updateWorld()
  // The child stops the service before it replaces the program, then a closed terminal kills it.
  const code = await runUpdate(w.env, { dryRun: false }, {
    version: '0.1.0',
    runProgram: async () => {
      await service.stop()
      return 129
    },
  })
  expect(code).toBe(1)
  expect(service.calls.filter((call) => call === 'start' || call === 'stop')).toEqual(['stop', 'start'])
  expect(w.out.at(-1)).toBe(`kinfold update: the new program's install stopped (exit 129); ${binPath} is still 0.1.0; the service is running`)
})

test('with an unavailable service the hand-off never starts or stops it', async () => {
  const { w } = updateWorld()
  const service = countingService(new StubService(w.env, 'test service'))
  w.env = { ...w.env, service }
  expect(await runUpdate(w.env, { dryRun: false }, { version: '0.1.0', runProgram: async () => 0 })).toBe(0)
  expect(await runUpdate(w.env, { dryRun: false }, { version: '0.1.0', runProgram: async () => 3 })).toBe(1)
  expect(w.out.at(-1)).toEndWith('; this platform has no background service')
  expect(service.steps).toEqual([])
})

// ---- the lock, and `update --auto` as the daemon starts it ------------------

const AUTO_LOG = (w: FakeWorld): string => join(w.dataDir, 'logs', 'auto-update.log')
const ok = async (): Promise<number> => 0

test('a second update is refused while another runs, and changes nothing', async () => {
  const { w, binPath, fetched } = updateWorld()
  acquireUpdateLock(w.dataDir, { pid: 4242, alive: () => true })
  expect(await runUpdate(w.env, { dryRun: false }, { version: '0.1.0', runProgram: noRun, lock: { alive: () => true } })).toBe(1)
  expect(w.out).toEqual(['kinfold update: another update is running (pid 4242); nothing was changed'])
  expect(fetched).toEqual([])
  expect(readFileSync(binPath, 'utf8')).toBe(OLD_PROGRAM)
  expect(updateLockHolder(w.dataDir, () => true)).toBe(4242)
})

test('the lock is released after an update, whether it worked or not', async () => {
  const { w } = updateWorld()
  expect(await runUpdate(w.env, { dryRun: false }, { version: '0.1.0', runProgram: ok })).toBe(0)
  expect(existsSync(join(w.dataDir, UPDATE_LOCK_FILE))).toBe(false)
  expect(await runUpdate(w.env, { dryRun: false }, { version: '0.1.0', runProgram: async () => 3 })).toBe(1)
  expect(existsSync(join(w.dataDir, UPDATE_LOCK_FILE))).toBe(false)
})

test('a dry run takes no lock and runs beside an update', async () => {
  const { w } = updateWorld()
  acquireUpdateLock(w.dataDir, { pid: 4242, alive: () => true })
  expect(await runUpdate(w.env, { dryRun: true }, { version: '0.1.0', runProgram: noRun, lock: { alive: () => true } })).toBe(0)
  expect(w.out[0]).toContain('dry run')
})

test('an automatic run installs a patch release, records it and logs to a file', async () => {
  const { w, service } = updateWorld({ tag: 'v0.1.1' })
  let ran: readonly string[] = []
  const code = await runUpdate(w.env, { dryRun: false, auto: true }, { version: '0.1.0', runProgram: async (_path, argv) => ((ran = argv), 0) })
  expect(code).toBe(0)
  expect(ran).toEqual(['--data-dir', w.dataDir, 'install', '--yes'])
  const state = readAutoState(w.dataDir)
  expect(state.updated).toMatchObject({ version: '0.1.1', previous: '0.1.0' })
  expect(state.failure).toBeNull()
  // Its terminal is gone, so every line goes to the log.
  expect(w.out).toEqual([])
  expect(readFileSync(AUTO_LOG(w), 'utf8')).toContain('kinfold updated to 0.1.1')
  expect(existsSync(join(w.dataDir, UPDATE_LOCK_FILE))).toBe(false)
  expect(service.calls).toContain('isRunning')
})

posixOnly('file modes')('the automatic run\'s log is owner-only', async () => {
  const { w } = updateWorld({ tag: 'v0.1.1' })
  await runUpdate(w.env, { dryRun: false, auto: true }, { version: '0.1.0', runProgram: ok })
  expect(statSync(AUTO_LOG(w)).mode & 0o777).toBe(0o600)
})

test('an automatic run clears the failure an earlier one recorded', async () => {
  const { w } = updateWorld({ tag: 'v0.1.1' })
  mergeAutoState(w.dataDir, { failure: { version: '0.1.1', at: 1, reason: 'earlier' } })
  expect(await runUpdate(w.env, { dryRun: false, auto: true }, { version: '0.1.0', runProgram: ok })).toBe(0)
  expect(readAutoState(w.dataDir).failure).toBeNull()
})

test('an automatic run leaves a release that is no longer a patch for kinfold update', async () => {
  // The daemon saw 0.1.1; by the time the updater asks, the latest release is a minor.
  const { w, binPath, fetched } = updateWorld({ tag: 'v0.2.0' })
  expect(await runUpdate(w.env, { dryRun: false, auto: true }, { version: '0.1.0', runProgram: noRun })).toBe(0)
  expect(fetched).toEqual([LATEST_RELEASE_URL])
  expect(readFileSync(binPath, 'utf8')).toBe(OLD_PROGRAM)
  expect(readAutoState(w.dataDir)).toEqual({ attempt: null, failure: null, updated: null })
  expect(readFileSync(AUTO_LOG(w), 'utf8')).toContain('0.2.0 is not a patch release of 0.1.0')
})

test('an automatic run that is already up to date records nothing', async () => {
  const { w } = updateWorld({ tag: 'v0.1.0' })
  expect(await runUpdate(w.env, { dryRun: false, auto: true }, { version: '0.1.0', runProgram: noRun })).toBe(0)
  expect(readAutoState(w.dataDir)).toEqual({ attempt: null, failure: null, updated: null })
})

test('an automatic run records why it failed and leaves the running version', async () => {
  const { w, binPath } = updateWorld({ tag: 'v0.1.1', program: () => new Response('kinfold program, tampered\n') })
  expect(await runUpdate(w.env, { dryRun: false, auto: true }, { version: '0.1.0', runProgram: noRun })).toBe(1)
  const state = readAutoState(w.dataDir)
  expect(state.failure).toMatchObject({ version: '0.1.1', reason: 'the downloaded program does not match the release checksums; nothing was changed' })
  expect(state.updated).toBeNull()
  expect(readFileSync(binPath, 'utf8')).toBe(OLD_PROGRAM)
  expect(existsSync(join(w.dataDir, UPDATE_LOCK_FILE))).toBe(false)
})

test('an automatic run whose install stops records that as the failure', async () => {
  const { w } = updateWorld({ tag: 'v0.1.1' })
  expect(await runUpdate(w.env, { dryRun: false, auto: true }, { version: '0.1.0', runProgram: async () => 3 })).toBe(1)
  expect(readAutoState(w.dataDir).failure?.reason).toContain("the new program's install stopped (exit 3)")
})

test('an automatic run that cannot reach GitHub is a failure for the release the daemon saw', async () => {
  const { w } = updateWorld({ tag: 'v0.1.1' })
  writeUpdateState(w.dataDir, { lastAttemptAt: 1, latestVersion: '0.1.1', checkedAt: 1, notified: {} })
  w.env = { ...w.env, fetch: async () => { throw new TypeError('offline') } }
  expect(await runUpdate(w.env, { dryRun: false, auto: true }, { version: '0.1.0', runProgram: noRun })).toBe(1)
  expect(readAutoState(w.dataDir).failure).toMatchObject({ version: '0.1.1', reason: 'could not ask GitHub for the latest release (TypeError)' })
})

test('an automatic run needs the background service to be running the daemon', async () => {
  const services: ((w: FakeWorld) => ServiceControl | null)[] = [() => fakeService({ running: false }), (w) => new StubService(w.env, 'test service'), () => null]
  for (const serviceFor of services) {
    const { w, fetched } = updateWorld({ tag: 'v0.1.1' })
    const service = serviceFor(w)
    writeUpdateState(w.dataDir, { lastAttemptAt: 1, latestVersion: '0.1.1', checkedAt: 1, notified: {} })
    w.env = { ...w.env, service }
    expect(await runUpdate(w.env, { dryRun: false, auto: true }, { version: '0.1.0', runProgram: noRun })).toBe(1)
    expect(fetched).toEqual([])
    // A blocker, not a failure to retry tomorrow: the daemon waits for the install or the service to change.
    expect(readAutoState(w.dataDir).failure).toMatchObject({ version: '0.1.1', reason: 'the daemon is not run by a background service here; run kinfold update', blocked: true, running: '0.1.0' })
    await w.cleanup()
  }
})

test('an automatic run started while another update runs does nothing at all', async () => {
  const { w, fetched } = updateWorld({ tag: 'v0.1.1' })
  acquireUpdateLock(w.dataDir, { pid: 4242, alive: () => true })
  expect(await runUpdate(w.env, { dryRun: false, auto: true }, { version: '0.1.0', runProgram: noRun, lock: { alive: () => true } })).toBe(0)
  expect(fetched).toEqual([])
  expect(readAutoState(w.dataDir)).toEqual({ attempt: null, failure: null, updated: null })
  expect(existsSync(AUTO_LOG(w))).toBe(false)
})

test('an automatic install that hangs is given up on and recorded, and the lock is let go', async () => {
  const { w } = updateWorld({ tag: 'v0.1.1' })
  const hung = (): Promise<number> => new Promise<number>(() => undefined)
  expect(await runUpdate(w.env, { dryRun: false, auto: true }, { version: '0.1.0', runProgram: hung, installTimeoutMs: 20 })).toBe(1)
  expect(readAutoState(w.dataDir).failure?.reason).toContain("the new program's install stopped (exit 124)")
  expect(existsSync(join(w.dataDir, UPDATE_LOCK_FILE))).toBe(false)
  expect(AUTO_INSTALL_TIMEOUT_MS).toBe(900_000)
})

test('an automatic run hands the install the agent homes saved at install time, and only those', async () => {
  const { w } = updateWorld({ tag: 'v0.1.1' })
  writeFileSync(join(w.dataDir, 'install.json'), JSON.stringify({ channel: 'curl', updateCheck: true, autoUpdate: true, firstInstalledAt: 1, agentHomes: { CODEX_HOME: '/opt/codex-home' } }))
  // The daemon's environment: no CODEX_HOME, and a JUNIE_HOME the install never ran with.
  w.env = { ...w.env, envVars: { ...w.env.envVars, JUNIE_HOME: '/not/from/install' } }
  let seen: Readonly<Record<string, string>> = {}
  expect(await runUpdate(w.env, { dryRun: false, auto: true }, { version: '0.1.0', runProgram: async (_path, _argv, vars) => ((seen = vars), 0) })).toBe(0)
  expect(seen.CODEX_HOME).toBe('/opt/codex-home')
  expect(seen.JUNIE_HOME).toBeUndefined()
  expect(seen.PATH).toBe('/usr/bin')
})

test('a manual update leaves the shell\'s agent homes as they are', async () => {
  const { w } = updateWorld()
  writeFileSync(join(w.dataDir, 'install.json'), JSON.stringify({ channel: 'curl', updateCheck: true, autoUpdate: true, firstInstalledAt: 1, agentHomes: { CODEX_HOME: '/opt/codex-home' } }))
  w.env = { ...w.env, envVars: { ...w.env.envVars, JUNIE_HOME: '/from/the/shell' } }
  let seen: Readonly<Record<string, string>> = {}
  expect(await runUpdate(w.env, { dryRun: false }, { version: '0.1.0', runProgram: async (_path, _argv, vars) => ((seen = vars), 0) })).toBe(0)
  expect(seen.JUNIE_HOME).toBe('/from/the/shell')
  expect(seen.CODEX_HOME).toBeUndefined()
})

test('the automatic run\'s log is trimmed to its newest part once it passes its cap', async () => {
  const { w } = updateWorld({ tag: 'v0.1.1' })
  mkdirSync(join(w.dataDir, 'logs'), { recursive: true })
  const line = (index: number): string => `2026-01-01T00:00:00.000Z old line ${String(index).padStart(6, '0')}\n`
  const count = Math.ceil((AUTO_LOG_MAX_BYTES + 4096) / line(0).length)
  writeFileSync(AUTO_LOG(w), Array.from({ length: count }, (_, index) => line(index)).join(''))
  expect(await runUpdate(w.env, { dryRun: false, auto: true }, { version: '0.1.0', runProgram: ok })).toBe(0)
  const text = readFileSync(AUTO_LOG(w), 'utf8')
  expect(text.length).toBeLessThan(AUTO_LOG_KEEP_BYTES + 4096)
  // Whole lines only, the newest of the old ones kept, and this run's lines after them.
  expect(text.startsWith('2026-01-01T00:00:00.000Z old line ')).toBe(true)
  expect(text).toContain(line(count - 1))
  expect(text).not.toContain(line(0))
  expect(text).toContain('kinfold updated to 0.1.1')
  expect(AUTO_LOG_MAX_BYTES).toBe(262_144)
  expect(AUTO_LOG_KEEP_BYTES).toBe(131_072)
})

test('a log under its cap is left as it is', async () => {
  const { w } = updateWorld({ tag: 'v0.1.1' })
  mkdirSync(join(w.dataDir, 'logs'), { recursive: true })
  writeFileSync(AUTO_LOG(w), 'an earlier run\n')
  expect(await runUpdate(w.env, { dryRun: false, auto: true }, { version: '0.1.0', runProgram: ok })).toBe(0)
  expect(readFileSync(AUTO_LOG(w), 'utf8').startsWith('an earlier run\n')).toBe(true)
})

test('an interrupt during the download releases the lock before the run ends', async () => {
  let arrived: () => void = () => undefined
  const reached = new Promise<void>((resolve) => { arrived = resolve })
  let finish: () => void = () => undefined
  const { w, binPath } = updateWorld({ program: () => new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(NEW_PROGRAM.slice(0, 5)))
      arrived()
      finish = () => {
        controller.enqueue(new TextEncoder().encode(NEW_PROGRAM.slice(5)))
        controller.close()
      }
    },
  })) })
  const realExit = process.exit
  let exitedWith = null as number | null
  process.exit = ((code?: number) => { exitedWith = code ?? 0 }) as typeof process.exit
  try {
    const running = runUpdate(w.env, { dryRun: false }, { version: '0.1.0', runProgram: ok })
    await reached
    await Bun.sleep(20)
    expect(existsSync(join(w.dataDir, UPDATE_LOCK_FILE))).toBe(true)
    process.emit('SIGINT')
    expect(exitedWith).toBe(130)
    expect(existsSync(join(w.dataDir, UPDATE_LOCK_FILE))).toBe(false)
    expect(tempFiles(binPath)).toEqual([])
    finish()
    await running.catch(() => undefined)
  } finally {
    process.exit = realExit
  }
})

// ---- quiet is checked again after the download ----

/** A world whose clock moves only when the updater sleeps, so a wait is as long as it says. */
function timedWorld(): { w: FakeWorld; binPath: string; fetched: string[]; slept: number[] } {
  const made = updateWorld({ tag: 'v0.1.1' })
  let clock = 1_792_900_000_000
  const slept: number[] = []
  made.w.env = { ...made.w.env, now: () => clock, sleep: async (ms) => { slept.push(ms); clock += ms } }
  return { ...made, slept }
}

test('an automatic run asks again whether agents are quiet once the download is checked, and waits out the rest', async () => {
  const { w, fetched, slept } = timedWorld()
  const answers = [QUIET_MS - 60_000, QUIET_MS]
  const askedAfter: number[] = []
  const quietForMs = async (): Promise<number | null> => {
    askedAfter.push(fetched.length)
    return answers.shift() ?? QUIET_MS
  }
  let installed = false
  expect(await runUpdate(w.env, { dryRun: false, auto: true }, { version: '0.1.0', runProgram: async () => ((installed = true), 0), quietForMs })).toBe(0)
  // Asked only once the release, the checksums and the program had all been fetched.
  expect(askedAfter).toEqual([3, 3])
  expect(slept).toEqual([60_000])
  expect(installed).toBe(true)
  expect(readFileSync(AUTO_LOG(w), 'utf8')).toContain('an agent was active 9 minutes ago; waiting 1 minute before installing')
})

test('agents that stay active past the cap leave the update for the next daily check, with nothing changed', async () => {
  const { w, binPath, slept } = timedWorld()
  expect(await runUpdate(w.env, { dryRun: false, auto: true }, { version: '0.1.0', runProgram: noRun, quietForMs: async () => 0 })).toBe(1)
  expect(slept.reduce((sum, ms) => sum + ms, 0)).toBeLessThanOrEqual(QUIET_WAIT_CAP_MS)
  expect(slept.length).toBeGreaterThan(1)
  expect(readAutoState(w.dataDir).failure).toMatchObject({ version: '0.1.1', reason: 'agents were still active 30 minutes after the download; nothing was changed' })
  expect(readAutoState(w.dataDir).failure?.blocked).toBeUndefined()
  expect(readFileSync(binPath, 'utf8')).toBe(OLD_PROGRAM)
  expect(tempFiles(binPath)).toEqual([])
  expect(QUIET_WAIT_CAP_MS).toBe(1_800_000)
})

test('a daemon that does not answer the quiet question holds nothing up: no agent can be mid-session with it', async () => {
  const { w, slept } = timedWorld()
  expect(await runUpdate(w.env, { dryRun: false, auto: true }, { version: '0.1.0', runProgram: ok, quietForMs: async () => null })).toBe(0)
  expect(slept).toEqual([])
})

test('a manual update never waits for quiet: the user asked for it now', async () => {
  const { w } = updateWorld()
  const quietForMs = async (): Promise<number | null> => {
    throw new Error('a manual update must not ask')
  }
  expect(await runUpdate(w.env, { dryRun: false }, { version: '0.1.0', runProgram: ok, quietForMs })).toBe(0)
})

// ---- on a terminal -------------------------------------------------------------

const drawnLines = (term: ReturnType<typeof fakeTerminal>): string[] =>
  term.output().split('\n').map((line) => line.slice(line.lastIndexOf('\r') + 1).replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '').trimEnd()).filter((line) => line !== '')

test('on a terminal update shows a spinner through the check, the download and the install, and ends on the result', async () => {
  const { w } = updateWorld()
  const term = fakeTerminal([])
  const code = await runFramed({ ...w.env, terminal: term }, 'update', (env) => runUpdate(env, { dryRun: false }, { version: '0.1.0', runProgram: async () => 0 }))
  expect(code).toBe(0)
  expect(w.out).toEqual([])
  expect(term.output()).toContain('looking for a newer release')
  expect(term.output()).toContain('downloading Kinfold 0.2.0')
  expect(term.output()).toContain('installing Kinfold 0.2.0')
  expect(drawnLines(term).slice(-2)).toEqual(['o  kinfold updated to 0.2.0', 'Done.'])
})

test('on a terminal an up-to-date program says so as the result', async () => {
  const { w } = updateWorld({ tag: 'v0.1.0' })
  const term = fakeTerminal([])
  expect(await runFramed({ ...w.env, terminal: term }, 'update', (env) => runUpdate(env, { dryRun: false }, { version: '0.1.0', runProgram: noRun }))).toBe(0)
  expect(drawnLines(term).slice(-2)).toEqual(['o  kinfold is up to date (0.1.0)', 'Done.'])
})

test('on a terminal a failed install of the new program ends the spinner as a failure', async () => {
  const { w, binPath } = updateWorld()
  const term = fakeTerminal([])
  expect(await runFramed({ ...w.env, terminal: term }, 'update', (env) => runUpdate(env, { dryRun: false }, { version: '0.1.0', runProgram: async () => 3 }))).toBe(1)
  expect(drawnLines(term).slice(-2)).toEqual([`x  kinfold update: the new program's install stopped (exit 3); ${binPath.replace(w.home, '~')} is still 0.1.0; the service is running`, 'kinfold update did not finish.'])
})

posixOnly('sh scripts')('on a terminal the default runner hides the new install\'s output and shows it above the failure when it fails', async () => {
  // The "new program" is a script that prints an install's lines and fails, as a broken install --yes would.
  const program = "#!/bin/sh\necho 'applying 2 actions'\necho '  2. start  [failed]'\nexit 3\n"
  const { w, binPath } = updateWorld({ program: () => new Response(program), sums: `${sha(program)}  ${ASSET}\n` })
  const term = fakeTerminal([])
  const code = await runFramed({ ...w.env, terminal: term }, 'update', (framed) => runUpdate(framed, { dryRun: false }, { version: '0.1.0' }))
  expect(code).toBe(1)
  const lines = drawnLines(term)
  expect(lines).toContain('|  applying 2 actions')
  expect(lines).toContain('|    2. start  [failed]')
  expect(lines.at(-2)).toBe(`x  kinfold update: the new program's install stopped (exit 3); ${binPath.replace(w.home, '~')} is still 0.1.0; the service is running`)
})

test("the new program's own output is kept off a terminal run and handed back for a failure", async () => {
  const script = join(world?.root ?? updateWorld().w.root, 'child.ts')
  writeFileSync(script, "console.log('applying 2 actions'); console.error('step 2 failed'); process.exit(3)\n")
  const result = await captureProgram(process.execPath, [script], { PATH: process.env.PATH ?? '' })
  expect(result).toEqual({ code: 3, lines: ['applying 2 actions', 'step 2 failed'] })
})
