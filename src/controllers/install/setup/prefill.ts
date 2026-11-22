// What the setup wizard starts from: the machine as it is now. Hosts come from
// the wiring on disk, observers from the daemon (or, with the daemon down,
// from memory.db opened read-only), encryption from the file's header, the
// port from the service config. Only install.json is read back from a saved
// file, and it holds only what nothing else knows. A refusal to guess is
// deliberate: when the saved observers cannot be read, the caller is told so
// and never gets the built-in defaults in their place.

import { existsSync, realpathSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { DEFAULT_PORT } from '../../daemon/port'
import { OBSERVER_PROVIDERS } from '../../../resources/observer/types'
import { dbKeyStoreOf } from '../../../resources/sqlite/keys'
import { fileState, openStoreFile } from '../../../resources/sqlite/open'
import { DB_FILE } from '../../../resources/store/data-dir'
import { listSafety } from '../../../resources/store/observer-safety-store'
import { rootCommitOf } from '../../../resources/store/project-key'
import type { Database } from '../../../resources/sqlite/types'
import { type RootFor, planRootMerges, unrootedFolders } from '../../../resources/store/project-merge'
import { type ObserverSettingsInput, listObserverSettings } from '../../../resources/store/observer-settings-store'
import type { WiringState } from '../../../resources/install-plan/claude-hooks'
import { getObserverSettings, readDaemonInfo } from '../daemon-client'
import { INSTALL_HOSTS, type InstallHost } from '../detect'
import type { InstallEnv } from '../../../resources/install-plan/env'
import { keyStoreOf } from '../key-store-choice'
import { ChoiceError, type ObserverFlag } from '../observer-choice'
import { serviceOf } from '../service/control'
import { DEFAULT_AUTO_UPDATE, type InstallChannel, currentChannel, readInstallRecord } from '../../../resources/install-plan/setup/record'
import { isWired, overlapState, profileOf } from '../../../plugins/agents/install-profiles'

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
  /** The running daemon backs off on a claude-cli login that expired or is missing, so setup offers a long-lived token. */
  claudeLoginFailing?: boolean
  encryption: 'on' | 'off' | 'new'
  port: number
  updateCheck: boolean
  autoUpdate: boolean
  /** The saved beta channel; off when nothing was saved. */
  beta: boolean
  /** The install predates auto-update, so its hosts are still owed the notice that it is on. */
  autoUpdateIntro: boolean
  channel: InstallChannel
  firstInstalledAt: number | null
}

export const UNREADABLE_OBSERVERS =
  'cannot read the saved observer settings (the daemon is down and memory.db did not open); start the daemon or pass --observer <host>=<provider>:<model>'

export const LOCKED_FOLDER_NOTE = 'Chosen at first install. To use another folder, uninstall and reinstall.'

function hostState(env: InstallEnv, host: InstallHost): WiringState | 'unknown' {
  return overlapState(env, profileOf(host))
}

/** A host Kinfold wires today; a saved row for any other host is not offered back. */
function isInstallHost(host: string): host is InstallHost {
  return (INSTALL_HOSTS as readonly string[]).includes(host)
}

interface RowLike {
  host: string
  provider: string
  model: string
  credentialRef: string | null
  enabled: boolean
  endpoint?: string
}

function toMap(rows: readonly RowLike[]): Map<InstallHost, ObserverSettingsInput> {
  const map = new Map<InstallHost, ObserverSettingsInput>()
  for (const row of rows) {
    if (!isInstallHost(row.host)) continue
    const provider = OBSERVER_PROVIDERS.find((known) => known === row.provider)
    if (provider === undefined) continue
    map.set(row.host, { host: row.host, provider, model: row.model, credentialRef: row.credentialRef, enabled: row.enabled, ...(row.endpoint === undefined ? {} : { endpoint: row.endpoint }) })
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
  return withReadonlyStore(env, dataDir, (db) => {
    const failed = new Set(listSafety(db).filter((row) => row.status === 'failed').map((row) => row.provider))
    return { rows: listObserverSettings(db), failedProviders: [...failed] }
  })
}

/**
 * One read-only open of the store under `dataDir`, with the key store's key,
 * closed when `read` returns. The one place the installer decides how to open
 * a store it does not own: read-only, and with a wait only on the live file,
 * since a daemon starting up may hold the WAL briefly while it recovers it.
 * Throws when the key or the file will not open.
 */
function withReadonlyStore<Result>(env: InstallEnv, dataDir: string, read: (db: Database) => Result): Result {
  const keys = dbKeyStoreOf(keyStoreOf({ ...env, dataDir }))
  const path = join(dataDir, DB_FILE)
  const target = storeTarget(path)
  const db = openStoreFile(path, { readonly: true, target, keys, ...(target === path ? { busyTimeoutMs: READ_BUSY_TIMEOUT_MS } : {}) })
  try {
    return read(db)
  } finally {
    db.close()
  }
}

interface SavedObservers {
  map: Map<InstallHost, ObserverSettingsInput>
  error: string | null
  failedProviders: string[]
  claudeLoginFailing?: boolean
}

const LOGIN_FAILURES: ReadonlySet<string> = new Set(['auth_expired', 'not_logged_in'])

async function savedObservers(env: InstallEnv, dataDir: string): Promise<SavedObservers> {
  const read = await getObserverSettings(env)
  if (read.ok) {
    // An older daemon sends no backoff list.
    const backoff = Array.isArray(read.view.backoff) ? read.view.backoff : []
    const claudeLoginFailing = backoff.some((entry) => entry.provider === 'claude-cli' && LOGIN_FAILURES.has(entry.errorClass))
    return { map: toMap(read.view.rows), error: null, failedProviders: [], claudeLoginFailing }
  }
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
  const wiredHosts = INSTALL_HOSTS.filter((host) => isWired(hostState(at, host)))
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
    claudeLoginFailing: observers.claudeLoginFailing === true,
    encryption: ({ plain: 'off', encrypted: 'on', new: 'new' } as const)[fileState(join(dataDir, DB_FILE))],
    // A configured service without the port key runs the daemon on its default port.
    port: service !== null && service.isConfigured() ? (service.configuredPort() ?? DEFAULT_PORT) : readDaemonInfo(dataDir).port,
    updateCheck: record?.updateCheck ?? true,
    autoUpdate: record?.autoUpdate ?? DEFAULT_AUTO_UPDATE,
    beta: record?.beta === true,
    autoUpdateIntro: record?.autoUpdateIntro ?? false,
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

/**
 * What the daemon will merge when it starts on this store: one repo under
 * two keys (a renamed remote, a fork), found by each key's first commit. The
 * install output says it before it happens, with the command that undoes it.
 * Read-only; empty for a new store, and when the store or git cannot say.
 */
/** The most folders the install looks up for its merge preview. */
export const MERGE_PREVIEW_FOLDERS = 40

export function mergePlanLines(env: InstallEnv, dataDir: string, rootFor: RootFor = (cwd) => rootCommitOfOrNull(cwd)): string[] {
  try {
    if (fileState(join(dataDir, DB_FILE)) === 'new') return []
    return withReadonlyStore(env, dataDir, (db) => {
      // Each folder is asked through a blocking child process (up to half a second when it hangs), with nothing drawn
      // meanwhile. Past a few dozen, the preview is left to the daemon, which asks without blocking and logs each merge.
      const folders = unrootedFolders(db).length
      if (folders > MERGE_PREVIEW_FOLDERS) return [`project: ${folders} projects have no repo root recorded yet; the daemon checks them when it starts, and kinfold status names any it merges`]
      return planRootMerges(db, rootFor).map((merge) => `project: ${merge.from} will merge into ${merge.into} (same repo); kinfold project split ${merge.fromKey} undoes it`)
    })
  } catch {
    return []
  }
}

function rootCommitOfOrNull(cwd: string): string | null {
  try {
    return rootCommitOf(cwd)
  } catch {
    return null
  }
}
