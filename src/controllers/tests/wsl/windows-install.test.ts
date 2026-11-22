import { afterEach, expect, test } from 'bun:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { CommandResult, InstallEnv } from '../install/env'
import { encodeText } from '../install/files'
import { YES, type FakeWorld, createWorld } from '../install/test-support'
import { taskXml } from '../install/service/scheduled-task-service'
import { wslInstall } from './entry'
import { INTEROP_OFF, WSLINFO, WSLPATH, findWindowsInstall, networkingMode, windowsDaemonHealth, windowsToolPath } from './windows-install'

const worlds: FakeWorld[] = []
afterEach(async () => {
  for (const world of worlds.splice(0)) await world.cleanup()
})

const WIN_APP_DATA = 'C:\\Users\\José\\AppData\\Local'
const WIN_DATA_DIR = 'C:\\Users\\José\\.kinfold'
/** Never the live daemon's 37811; the fake fetch answers it without any socket. */
const PORT = 47_811

interface Stand {
  world: FakeWorld
  env: InstallEnv
  appData: string
  dataDir: string
  interop: boolean
  mode: string | null
}

/** A linux-WSL world whose interop answers from a temp folder standing in for /mnt/c. */
function stand(options: { xml?: boolean; record?: boolean; daemon?: 'up' | 'down' | 'none' } = {}): Stand {
  const state = { interop: true, mode: 'mirrored' as string | null }
  let driveC = ''
  const paths = (): Record<string, string> => ({ [WIN_APP_DATA]: join(driveC, 'Users', 'José', 'AppData', 'Local'), [WIN_DATA_DIR]: join(driveC, 'Users', 'José', '.kinfold') })
  const answer = (argv: readonly string[]): CommandResult | undefined => {
    const [binary] = argv
    if (binary?.endsWith('powershell.exe') === true) return state.interop ? { exitCode: 0, stdout: `${WIN_APP_DATA}\r\n` } : { exitCode: 127, stdout: '' }
    if (binary === WSLPATH) {
      const path = paths()[argv[2] ?? '']
      return path === undefined ? { exitCode: 1, stdout: '' } : { exitCode: 0, stdout: `${path}\n` }
    }
    if (binary === WSLINFO) return state.mode === null ? { exitCode: 127, stdout: '' } : { exitCode: 0, stdout: `${state.mode}\n` }
    return undefined
  }
  const world = createWorld({ platform: 'linux', withLibrary: false, commandOverride: answer })
  worlds.push(world)
  driveC = join(world.root, 'mnt-c')
  const appData = paths()[WIN_APP_DATA]!
  const dataDir = paths()[WIN_DATA_DIR]!
  mkdirSync(join(appData, 'Kinfold'), { recursive: true })
  mkdirSync(dataDir, { recursive: true })
  if (options.xml ?? true) {
    const xml = taskXml({ user: 'PC\\José', program: `${WIN_DATA_DIR}\\bin\\kinfold.exe`, dataDir: WIN_DATA_DIR, port: PORT, logFile: `${WIN_DATA_DIR}\\logs\\daemon.log` })
    writeFileSync(join(appData, 'Kinfold', 'kinfold-daemon.xml'), encodeText(xml, 'utf16le'))
  }
  if (options.record ?? true) writeFileSync(join(dataDir, 'install.json'), '{"channel":"powershell","updateCheck":true,"firstInstalledAt":1}\n')
  const daemon = options.daemon ?? 'up'
  if (daemon !== 'none') writeFileSync(join(dataDir, 'daemon.json'), `${JSON.stringify({ pid: 4242, port: PORT })}\n`)
  const fetch: InstallEnv['fetch'] = async (url) => {
    world.fetches.push(`GET ${new URL(url).pathname}`)
    if (daemon !== 'up' || new URL(url).port !== String(PORT)) throw new TypeError('connection refused (test world)')
    return Response.json({ ok: true, version: '1.2.3', schemaVersion: 7, pid: 4242 })
  }
  const env: InstallEnv = { ...world.env, platform: 'linux', wsl: true, fetch }
  return Object.assign(state, { world, env, appData, dataDir })
}

test('install finds the Windows folder from the task config', async () => {
  const s = stand()
  const found = await findWindowsInstall(s.env)
  expect(found).toEqual({
    kind: 'found',
    link: { windowsDataDir: WIN_DATA_DIR, dataDir: s.dataDir, taskConfig: join(s.appData, 'Kinfold', 'kinfold-daemon.xml') },
  })
  const powershell = s.world.commands.find((request) => request.argv[0]?.endsWith('powershell.exe') === true)
  // By its full path on the C: drive mount, never by bare name.
  expect(powershell?.argv[0]).toBe('/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe')
  expect(powershell?.argv).toContain('-EncodedCommand')
})

test('each missing piece is named', async () => {
  const off = stand()
  off.interop = false
  const noXml = stand({ xml: false })
  const noRecord = stand({ record: false })
  const xmlPath = join(noXml.appData, 'Kinfold', 'kinfold-daemon.xml')
  const cases: [Stand, string][] = [
    [off, INTEROP_OFF],
    [noXml, `no Kinfold scheduled task config at ${xmlPath}`],
    [noRecord, `the scheduled task names ${WIN_DATA_DIR}, which has no install.json`],
  ]
  for (const [s, reason] of cases) {
    expect(await findWindowsInstall(s.env)).toEqual({ kind: 'none', reason })
    expect(await wslInstall(s.env, YES)).toBeNull()
    expect(s.world.out).toContain(`WSL (preview): no Windows install found (${reason}); installing a separate Linux memory in this distro`)
  }
  expect(INTEROP_OFF).toBe('Windows interop is off in this distro')
})

test('networking mode reads wslinfo, and anything else is unknown', async () => {
  const s = stand()
  expect(await networkingMode(s.env)).toBe('mirrored')
  s.mode = 'nat'
  expect(await networkingMode(s.env)).toBe('nat')
  s.mode = 'virtioproxy'
  expect(await networkingMode(s.env)).toBe('unknown')
  s.mode = null
  expect(await networkingMode(s.env)).toBe('unknown')
})

test('daemon health names the port, or that no daemon.json exists', async () => {
  const up = stand()
  expect(await windowsDaemonHealth(up.env, up.dataDir)).toEqual({ up: true, port: PORT, version: '1.2.3' })
  const down = stand({ daemon: 'down' })
  expect(await windowsDaemonHealth(down.env, down.dataDir)).toMatchObject({ up: false, port: PORT })
  const none = stand({ daemon: 'none' })
  expect(await windowsDaemonHealth(none.env, none.dataDir)).toMatchObject({ up: false, port: null })
})

test('a daemon answering with another pid is not the Windows daemon', async () => {
  const s = stand()
  writeFileSync(join(s.dataDir, 'daemon.json'), `${JSON.stringify({ pid: 99, port: PORT })}\n`)
  expect(await windowsDaemonHealth(s.env, s.dataDir)).toMatchObject({ up: false, port: PORT })
})

test('a Windows tool path maps onto the drive mount', () => {
  expect(windowsToolPath('C:\\Windows\\System32\\x.exe')).toBe('/mnt/c/Windows/System32/x.exe')
  expect(windowsToolPath('D:\\a b\\c')).toBe('/mnt/d/a b/c')
  expect(windowsToolPath('/already/posix')).toBe('/already/posix')
})
