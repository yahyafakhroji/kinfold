import { afterEach, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { existsSync, fstatSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { installedProgramPath } from '../install/entry'
import { installProgram, releaseAssetName } from '../install/self-install'
import { type FakeService, type FakeWorld, createWorld, fakeService } from '../install/test-support'
import { LATEST_RELEASE_URL } from './check'
import { programUrl, runUpdate } from './update'

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
  expect(service.calls).not.toContain('stop')
})

test('a truncated download leaves the old program running', async () => {
  const { w, binPath, service } = updateWorld({ program: () => new Response(NEW_PROGRAM.slice(0, 10)) })
  expect(await runUpdate(w.env, { dryRun: false }, { version: '0.1.0', runProgram: noRun })).toBe(1)
  expect(w.out.at(-1)).toBe('kinfold update: the downloaded program does not match the release checksums; nothing was changed')
  expect(tempFiles(binPath)).toEqual([])
  expect(readFileSync(binPath, 'utf8')).toBe(OLD_PROGRAM)
  expect(service.calls).not.toContain('stop')
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

test('a verified program is handed install --yes with the saved channel', async () => {
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
  expect(service.calls).toEqual([])
})

test('a failed hand-off says the old program is still in place', async () => {
  const { w, binPath } = updateWorld()
  const code = await runUpdate(w.env, { dryRun: false }, { version: '0.1.0', runProgram: async () => 3 })
  expect(code).toBe(1)
  expect(w.out.at(-1)).toBe(`kinfold update: the new program's install stopped (exit 3); ${binPath} is still 0.1.0`)
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
