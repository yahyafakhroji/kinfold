// What the setup wizard starts from: the machine as it is now. Hosts come from
// the wiring on disk, observers from the daemon (or, with the daemon down,
// from memory.db opened read-only), encryption from the file's header, the
// port from the service config. Only install.json is read back from a saved
// file, and it holds only what nothing else knows. A refusal to guess is
// deliberate: when the saved observers cannot be read, the caller is told so
// and never gets the built-in defaults in their place.

import { join, resolve } from 'node:path'
import { OBSERVER_PROVIDERS } from '../../observer/types'
import { DB_KEY_REF } from '../../secrets/credentials'
import { createKeychainProvider } from '../../secrets/keychain'
import { credentialWriterFor } from '../../secrets/keychain-writer'
import { credentialDbKeyStore } from '../../sqlite/keys'
import { fileState, openStoreFile } from '../../sqlite/open'
import { DB_FILE } from '../../store/data-dir'
import { type ObserverSettingsInput, listObserverSettings } from '../../store/observer-settings-store'
import { type WiringState, inspectSamHooks } from '../claude-hooks'
import { getObserverSettings, readDaemonInfo } from '../daemon-client'
import { INSTALL_HOSTS, type InstallHost } from '../detect'
import { type InstallEnv, installPaths } from '../env'
import { entryCommand } from '../entry'
import { readJsonObject, readTextOrNull } from '../files'
import { hostWiringState } from '../host-wiring'
import { ChoiceError, type ObserverFlag } from '../observer-choice'
import { inspectShim } from '../opencode-shim'
import { serviceOf } from '../service/control'
import { type InstallChannel, currentChannel, readInstallRecord } from './record'

export interface SetupState {
  /** install.json exists, or the service config names a data folder. */
  installed: boolean
  /** The folder already installed, else the one this run resolved. */
  dataDir: string
  wiredHosts: InstallHost[]
  observers: ReadonlyMap<InstallHost, ObserverSettingsInput>
  /** Why the saved observers could not be read; null when they were, or when there is nothing to read. */
  observersError: string | null
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

/** The store opened read-only with the platform key; throws when the key or the file will not open. */
function readStoreRows(env: InstallEnv, dataDir: string): RowLike[] {
  const writer = credentialWriterFor(env.platform, env.security)
  const keychain = createKeychainProvider((args) => env.security({ args }))
  const keys = credentialDbKeyStore('keychain', keychain, () => writer?.exists(DB_KEY_REF) ?? false)
  const db = openStoreFile(join(dataDir, DB_FILE), { readonly: true, keys })
  try {
    return listObserverSettings(db)
  } finally {
    db.close()
  }
}

async function savedObservers(env: InstallEnv, dataDir: string): Promise<{ map: Map<InstallHost, ObserverSettingsInput>; error: string | null }> {
  const read = await getObserverSettings(env)
  if (read.ok) return { map: toMap(read.view.rows), error: null }
  if (fileState(join(dataDir, DB_FILE)) === 'new') return { map: new Map(), error: null }
  try {
    return { map: toMap(readStoreRows(env, dataDir)), error: null }
  } catch {
    return { map: new Map(), error: UNREADABLE_OBSERVERS }
  }
}

export async function readSetupState(env: InstallEnv): Promise<SetupState> {
  const service = serviceOf(env)
  const configured = service !== null && service.isConfigured() ? service.configuredDataDir() : null
  const dataDir = configured ?? env.dataDir
  const record = readInstallRecord(dataDir)
  const installed = configured !== null || record !== null
  const at: InstallEnv = { ...env, dataDir }
  const wiredHosts = INSTALL_HOSTS.filter((host) => WIRED_STATES.includes(hostState(at, host)))
  const observers = installed ? await savedObservers(at, dataDir) : { map: new Map<InstallHost, ObserverSettingsInput>(), error: null }
  return {
    installed,
    dataDir,
    wiredHosts,
    observers: observers.map,
    observersError: observers.error,
    encryption: ({ plain: 'off', encrypted: 'on', new: 'new' } as const)[fileState(join(dataDir, DB_FILE))],
    port: service?.configuredPort() ?? readDaemonInfo(dataDir).port,
    updateCheck: record?.updateCheck ?? true,
    channel: currentChannel(env, record),
    firstInstalledAt: record?.firstInstalledAt ?? null,
  }
}

/** The refusal for a folder other than the installed one; null for the same folder, no request, or a first install. */
export function lockedFolderProblem(state: SetupState, requested: string | null): string | null {
  if (!state.installed || requested === null) return null
  if (resolve(requested) === resolve(state.dataDir)) return null
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
