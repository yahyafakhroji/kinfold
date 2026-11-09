// What the setup wizard starts from: the machine as it is now. Hosts come from
// the wiring on disk, observers from the daemon (or, with the daemon down,
// from memory.db opened read-only), encryption from the file's header, the
// port from the service config. Only install.json is read back from a saved
// file, and it holds only what nothing else knows. A refusal to guess is
// deliberate: when the saved observers cannot be read, the caller is told so
// and never gets the built-in defaults in their place.

import { existsSync, realpathSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { DEFAULT_PORT } from '../../daemon/daemon'
import { OBSERVER_PROVIDERS } from '../../observer/types'
import { dbKeyStoreOf } from '../../sqlite/keys'
import { fileState, openStoreFile } from '../../sqlite/open'
import { DB_FILE } from '../../store/data-dir'
import { listSafety } from '../../store/observer-safety-store'
import { type ObserverSettingsInput, listObserverSettings } from '../../store/observer-settings-store'
import { type WiringState, inspectSamHooks } from '../claude-hooks'
import { getObserverSettings, readDaemonInfo } from '../daemon-client'
import { INSTALL_HOSTS, type InstallHost } from '../detect'
import { type InstallEnv, installPaths } from '../env'
import { entryCommand } from '../entry'
import { readJsonObject, readTextOrNull } from '../files'
import { hostWiringState } from '../host-wiring'
import { keyStoreOf } from '../key-store-choice'
import { ChoiceError, type ObserverFlag } from '../observer-choice'
import { inspectShim } from '../opencode-shim'
import { serviceOf } from '../service/control'
import { type InstallChannel, currentChannel, readInstallRecord } from './record'

export interface SetupState {
  /** install.json exists, or the service config names a data folder. */
  installed: boolean
  /** The folder holds an install: it is installed, or this run just moved one there from the old name. */
  folderLocked: boolean
  /** The folder already installed, else the one this run resolved. */
  dataDir: string
  wiredHosts: InstallHost[]
  observers: ReadonlyMap<InstallHost, ObserverSettingsInput>
  /** Why the saved observers could not be read; null when they were, or when there is nothing to read. */
  observersError: string | null
  /**
   * Providers with a failed safety row, read from memory.db when the daemon was down; empty when the
   * daemon answered (install asks it again) or nothing could be read. A saved choice for one still gets its PUT.
   */
  failedProviders: readonly string[]
  encryption: 'on' | 'off' | 'new'
  port: number
  updateCheck: boolean
  channel: InstallChannel
  firstInstalledAt: number | null
}

export const UNREADABLE_OBSERVERS =
  'cannot read the saved observer settings (the daemon is down and memory.db did not open); start the daemon or pass --observer <host>=<provider>:<model>'

export const LOCKED_FOLDER_NOTE = 'Chosen at first install. To use another folder, uninstall and reinstall.'

const WIRED_STATES: readonly (WiringState | 'foreign' | 'unknown')[] = ['yes', 'stale', 'partial']

function claudeState(env: InstallEnv): WiringState | 'unknown' {
  try {
    const file = readJsonObject(installPaths(env).claudeSettings)
    return file.exists ? inspectSamHooks(file.value, entryCommand(env.mode, 'hook', env.dataDir)) : 'no'
  } catch {
    return 'unknown'
  }
}

function opencodeState(env: InstallEnv): WiringState | 'foreign' {
  const paths = installPaths(env)
  return inspectShim(readTextOrNull(paths.opencodePlugin), { pluginEntry: paths.pluginEntry, dataDir: env.dataDir })
}

function hostState(env: InstallEnv, host: InstallHost): WiringState | 'foreign' | 'unknown' {
  if (host === 'claude-code') return claudeState(env)
  if (host === 'opencode') return opencodeState(env)
  return hostWiringState(env, host)
}

function isInstallHost(host: string): host is InstallHost {
  return (INSTALL_HOSTS as readonly string[]).includes(host)
}

interface RowLike {
  host: string
  provider: string
  model: string
  credentialRef: string | null
  enabled: boolean
}

function toMap(rows: readonly RowLike[]): Map<InstallHost, ObserverSettingsInput> {
  const map = new Map<InstallHost, ObserverSettingsInput>()
  for (const row of rows) {
    if (!isInstallHost(row.host)) continue
    const provider = OBSERVER_PROVIDERS.find((known) => known === row.provider)
    if (provider === undefined) continue
    map.set(row.host, { host: row.host, provider, model: row.model, credentialRef: row.credentialRef, enabled: row.enabled })
  }
  return map
}

const READ_BUSY_TIMEOUT_MS = 1000

function immutableUri(path: string): string {
  return `file:${path.split('/').map(encodeURIComponent).join('/')}?mode=ro&immutable=1`
}

function nonEmpty(path: string): boolean {
  try {
    return statSync(path).size > 0
  } catch {
    return false
  }
}

/**
 * How to open the store so the rows read are the committed ones; throws when
 * no open can promise that. Both side files: a plain read-only open, which
 * reads the WAL, and nothing else, because immutable would skip it. A
 * non-empty -wal without its -shm (a daemon that died, or one recovering it
 * right now) may hold committed rows immutable cannot see, so it is refused.
 * Otherwise immutable, which writes nothing: a plain read-only open of a WAL
 * store would create the side files, and with no -shm and no non-empty -wal
 * nothing has the store open and nothing is left to replay.
 */
function storeTarget(path: string): string {
  const wal = existsSync(`${path}-wal`)
  const shm = existsSync(`${path}-shm`)
  if (wal && shm) return path
  if (nonEmpty(`${path}-wal`)) throw new Error('memory.db has a -wal without its -shm')
  return immutableUri(path)
}

export interface StoreState {
  rows: RowLike[]
  /** Providers with a failed safety row. */
  failedProviders: string[]
}

/** The store's rows and failed safety providers in one read-only open, with the key store's key; throws when the key or the file will not open. */
export function readStoreState(env: InstallEnv, dataDir: string): StoreState {
  const keys = dbKeyStoreOf(keyStoreOf({ ...env, dataDir }))
  const path = join(dataDir, DB_FILE)
  const target = storeTarget(path)
  // A daemon starting up may hold the WAL briefly while it recovers it, so the wait is set before the key and the first read.
  const db = openStoreFile(path, { readonly: true, target, keys, ...(target === path ? { busyTimeoutMs: READ_BUSY_TIMEOUT_MS } : {}) })
  try {
    const failed = new Set(listSafety(db).filter((row) => row.status === 'failed').map((row) => row.provider))
    return { rows: listObserverSettings(db), failedProviders: [...failed] }
  } finally {
    db.close()
  }
}

interface SavedObservers {
  map: Map<InstallHost, ObserverSettingsInput>
  error: string | null
  failedProviders: string[]
}

async function savedObservers(env: InstallEnv, dataDir: string): Promise<SavedObservers> {
  const read = await getObserverSettings(env)
  if (read.ok) return { map: toMap(read.view.rows), error: null, failedProviders: [] }
  try {
    if (fileState(join(dataDir, DB_FILE)) === 'new') return { map: new Map(), error: null, failedProviders: [] }
    const state = readStoreState(env, dataDir)
    return { map: toMap(state.rows), error: null, failedProviders: state.failedProviders }
  } catch {
    return { map: new Map(), error: UNREADABLE_OBSERVERS, failedProviders: [] }
  }
}

/** The installed folder: the service's, else the first candidate holding install.json; null when none does. */
function installedFolder(env: InstallEnv, configured: string | null): { dataDir: string; record: ReturnType<typeof readInstallRecord> } | null {
  if (configured !== null) return { dataDir: configured, record: readInstallRecord(configured) }
  // --data-dir replaces env.dataDir, so the folder this run would have used without it is checked first.
  for (const dir of new Set([env.unflaggedDataDir, env.dataDir])) {
    const record = dir === undefined ? null : readInstallRecord(dir)
    if (dir !== undefined && record !== null) return { dataDir: dir, record }
  }
  return null
}

export interface SetupStateOptions {
  /**
   * This run just moved an install from the old name into env.dataDir. Its
   * plist is gone and the new one and install.json are not written yet, so
   * nothing on disk says installed; the moved store must still lock the folder.
   * Its old wiring is not recognised, so the agents still default to the
   * detected ones, as on a first install.
   */
  migrated?: boolean
}

export async function readSetupState(env: InstallEnv, options: SetupStateOptions = {}): Promise<SetupState> {
  const service = serviceOf(env)
  const configured = service !== null && service.isConfigured() ? service.configuredDataDir() : null
  const found = installedFolder(env, configured)
  const dataDir = found?.dataDir ?? env.dataDir
  const record = found?.record ?? null
  const installed = found !== null
  const at: InstallEnv = { ...env, dataDir }
  const wiredHosts = INSTALL_HOSTS.filter((host) => WIRED_STATES.includes(hostState(at, host)))
  // Whatever `installed` says: a store with saved rows and no install.json (a pre-wizard install off macOS) must not read as empty.
  const observers = await savedObservers(at, dataDir)
  return {
    installed,
    folderLocked: installed || options.migrated === true,
    dataDir,
    wiredHosts,
    observers: observers.map,
    observersError: observers.error,
    failedProviders: observers.failedProviders,
    encryption: ({ plain: 'off', encrypted: 'on', new: 'new' } as const)[fileState(join(dataDir, DB_FILE))],
    // A configured service without the port key runs the daemon on its default port.
    port: service !== null && service.isConfigured() ? (service.configuredPort() ?? DEFAULT_PORT) : readDaemonInfo(dataDir).port,
    updateCheck: record?.updateCheck ?? true,
    channel: currentChannel(env, record),
    firstInstalledAt: record?.firstInstalledAt ?? null,
  }
}

/** The same folder by its real path when both exist, else by its text. */
function sameFolder(a: string, b: string): boolean {
  const real = (path: string): string => (existsSync(path) ? realpathSync(path) : resolve(path))
  return real(a) === real(b)
}

/** The refusal for a folder other than the installed one; null for the same folder, no request, or a first install. */
export function lockedFolderProblem(state: SetupState, requested: string | null): string | null {
  if (!state.folderLocked || requested === null) return null
  if (sameFolder(requested, state.dataDir)) return null
  return `the memory folder is ${state.dataDir}, not ${requested}. ${LOCKED_FOLDER_NOTE}`
}

/**
 * The saved rows `--yes` keeps. Refuses, naming --observer, when they could
 * not be read and some host has no --observer flag to say what it wants; the
 * built-in default is never put in their place.
 */
export function savedObserversForYes(state: SetupState, hosts: readonly InstallHost[], flags: readonly ObserverFlag[]): ReadonlyMap<InstallHost, ObserverSettingsInput> {
  if (state.observersError !== null && hosts.some((host) => !flags.some((flag) => flag.host === host))) throw new ChoiceError(state.observersError)
  return state.observers
}
