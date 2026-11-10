import { afterEach, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, fstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { installedProgramPath } from '../install/entry'
import { installProgram, releaseAssetName } from '../install/self-install'
import { type FakeService, type FakeWorld, countingService, createWorld, fakeService } from '../install/test-support'
import { StubService } from '../install/service/stub-service'
import { LATEST_RELEASE_URL } from './check'
import { programUrl, runUpdate } from './update'
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
  const answers: Record<string, () => Response> = {
    [LATEST_RELEASE_URL]: () => new Response(JSON.stringify({ tag_name: release.tag ?? 'v0.2.0', draft: false, prerelease: false })),
    [SUMS_URL]: () => new Response(release.sums ?? `${sha(NEW_PROGRAM)}  ${ASSET}\n`),
    [PROGRAM_URL]: release.program ?? (() => new Response(NEW_PROGRAM)),
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

test("leftovers of dead update runs are swept, a live run's file is kept", async () => {
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

test('a dry run lists dead leftovers by name and removes nothing', async () => {
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

test('a folder with a temp name is skipped, and an unremovable leftover is named, not fatal', async () => {
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
