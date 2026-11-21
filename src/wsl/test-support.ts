// A WSL distro linked to a Windows install, made of fakes: interop answers
// from a temp folder standing in for /mnt/c, and a fake fetch stands in for
// the Windows daemon. Tests only.

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AgentId } from '../agents/profile'
import { stubDiskCheck } from '../install/disk/stub-check'
import type { CommandResult, InstallEnv } from '../install/env'
import { encodeText } from '../install/files'
import { EXIT_OK, type InstallOptions } from '../install/install'
import { DEVELOPMENT_VERSION } from '../install/self-install'
import type { EmbeddedAssets } from '../runtime/embedded'
import { taskXml } from '../install/service/scheduled-task-service'
import { YES, type FakeWorld, type WorldOptions, createWorld } from '../install/test-support'
import { wslInstall } from './entry'
import { wslHomeDir } from './link'
import { WSLINFO, WSLPATH } from './windows-install'

export const WIN_APP_DATA = 'C:\\Users\\José\\AppData\\Local'
export const WIN_DATA_DIR = 'C:\\Users\\José\\.kinfold'
/** Never the live daemon's 37811; the fake fetch answers it without any socket. */
export const PORT = 47_811
/** What the stand's build carries as the OpenCode and Kilo plugin bundle. */
export const PLUGIN_BUNDLE = '// Kinfold plugin (test stand-in)\nexport default {}\n'

export interface Stand {
  world: FakeWorld
  env: InstallEnv
  /** The temp folder standing in for /mnt/c. */
  driveC: string
  dataDir: string
  options: InstallOptions
  daemon: 'up' | 'down'
  mode: string
}

export interface StandOptions {
  daemonJson?: boolean
  hosts?: readonly AgentId[]
  /** Answers a command before the stand's interop does. */
  commandOverride?: WorldOptions['commandOverride']
}

/** A linux-WSL world whose interop answers from a temp folder standing in for /mnt/c. */
export function stand(options: StandOptions = {}): Stand & { cleanup: () => Promise<void> } {
  const state = { daemon: 'up' as 'up' | 'down', mode: 'mirrored' }
  let driveC = ''
  const paths = (): Record<string, string> => ({ [WIN_APP_DATA]: join(driveC, 'Users', 'José', 'AppData', 'Local'), [WIN_DATA_DIR]: join(driveC, 'Users', 'José', '.kinfold') })
  const answer = (argv: readonly string[]): CommandResult | undefined => {
    const own = options.commandOverride?.(argv)
    if (own !== undefined) return own
    const [binary] = argv
    if (binary?.endsWith('powershell.exe') === true) return { exitCode: 0, stdout: `${WIN_APP_DATA}\r\n` }
    if (binary === WSLPATH) {
      const path = paths()[argv[2] ?? '']
      return path === undefined ? { exitCode: 1, stdout: '' } : { exitCode: 0, stdout: `${path}\n` }
    }
    if (binary === WSLINFO) return { exitCode: 0, stdout: `${state.mode}\n` }
    return undefined
  }
  const world = createWorld({ platform: 'linux', withLibrary: false, claudeVersion: '2.1.0', commandOverride: answer })
  driveC = join(world.root, 'mnt-c')
  const appData = paths()[WIN_APP_DATA]!
  const dataDir = paths()[WIN_DATA_DIR]!
  mkdirSync(join(appData, 'Kinfold'), { recursive: true })
  mkdirSync(dataDir, { recursive: true })
  const xml = taskXml({ user: 'PC\\José', program: `${WIN_DATA_DIR}\\bin\\kinfold.exe`, dataDir: WIN_DATA_DIR, port: PORT, logFile: `${WIN_DATA_DIR}\\logs\\daemon.log` })
  writeFileSync(join(appData, 'Kinfold', 'kinfold-daemon.xml'), encodeText(xml, 'utf16le'))
  writeFileSync(join(dataDir, 'install.json'), '{"channel":"powershell","updateCheck":true,"firstInstalledAt":1}\n')
  if (options.daemonJson ?? true) writeFileSync(join(dataDir, 'daemon.json'), `${JSON.stringify({ pid: process.pid, port: PORT })}\n`)
  const fetch: InstallEnv['fetch'] = async (url) => {
    world.fetches.push(`GET ${new URL(url).pathname}`)
    if (state.daemon !== 'up' || new URL(url).port !== String(PORT)) throw new TypeError('connection refused (test world)')
    return Response.json({ ok: true, version: '1.2.3', schemaVersion: 7, pid: process.pid })
  }
  const env: InstallEnv = { ...world.env, platform: 'linux', wsl: true, fetch, unflaggedDataDir: world.dataDir, diskCheck: stubDiskCheck('test disk') }
  const programSource = join(world.root, 'kinfold-build')
  writeFileSync(programSource, 'the kinfold program stand-in')
  // A checkout carries no plugin bundle; a release build does, so the stand hands one in.
  const opencodeAssets = { opencodePlugin: async () => PLUGIN_BUNDLE, kiloPlugin: async () => PLUGIN_BUNDLE } as unknown as EmbeddedAssets
  const installOptions: InstallOptions = { ...YES, hosts: [...(options.hosts ?? ['claude-code'])], programSource, releaseVersion: DEVELOPMENT_VERSION, opencodeAssets }
  return Object.assign(state, { world, env, driveC, dataDir, options: installOptions, cleanup: () => world.cleanup() })
}

/** A stand already linked by a WSL install. */
export async function linkedStand(options: StandOptions = {}): Promise<Stand & { cleanup: () => Promise<void> }> {
  const s = stand(options)
  const code = await wslInstall(s.env, s.options)
  if (code !== EXIT_OK) throw new Error(`the WSL install failed with ${code}: ${s.world.out.join('\n')}`)
  return s
}

/** ~/.kinfold-wsl/bin/kinfold: what every linked agent runs. */
export function wslProgram(s: Stand): string {
  return join(wslHomeDir(s.world.home), 'bin', 'kinfold')
}

/**
 * Whether a config's text names `path`, written as is or escaped the way JSON
 * and TOML strings escape it: on a Windows test host a path has backslashes,
 * which those files double. ~/.kinfold-wsl does not count as ~/.kinfold.
 */
export function mentions(text: string, path: string): boolean {
  const spellings = new Set([path, JSON.stringify(path).slice(1, -1)])
  return [...spellings].some((spelling) => text.split(spelling).slice(1).some((rest) => !rest.startsWith('-wsl')))
}
