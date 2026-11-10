// `kinfold uninstall`: unload and remove the LaunchAgent, take our hook entries out
// of ~/.claude/settings.json and remove the OpenCode shim. Hook and MCP entries
// are found by what they run (entry.ts), so a checkout install and an installed
// program are removed the same way. Every other entry stays. The installed
// program and libraries go too; the rest of the data dir and
// the keychain entries stay, because they hold the
// user's memory and keys; the command prints how to remove them, and
// --remove-credentials deletes our credential entries. The HMAC master and
// legacy key stay with the data dir, since stored refs need them,
// unless --remove-hmac-keys: that writes hmac.key back from
// hmac-legacy, then deletes both entries and hmac.d/ (hmac-cleanup.ts).
// With an unreadable key-store.json the store is unknown, so no key is
// deleted; everything else is still removed, and the record is named.

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { KEYCHAIN_SERVICE, isSystemCredentialRef } from '../secrets/credentials'
import type { KeyStore } from '../secrets/key-store'
import { OPENROUTER_CREDENTIAL_REF } from '../observer/settings'
import { removeSamHooks } from './claude-hooks'
import { getObserverSettings } from './daemon-client'
import { type InstallEnv, errorMessage, installPaths, platformOf } from './env'
import { plannedBackup, readJsonObject, readTextOrNull, serializeJson } from './files'
import { EXIT_FAILED, EXIT_OK } from './install'
import { INSTALL_HOSTS, type InstallHost } from './detect'
import { claudeMcpUninstallActions, opencodeMcpUninstallActions } from './mcp-wiring'
import { hmacRemoval } from './hmac-cleanup'
import { hmacKeptNotes } from './hmac-migration'
import { codexHookUninstallActions, hostHookUninstallActions } from './host-wiring'
import { readKeyStore, secretDeleteAction } from './key-store-choice'
import { inspectShim } from './opencode-shim'
import { type Action, runPlan } from './plan'
import { managedServiceOf } from './service/control'
import { wslUninstall } from '../wsl/entry'

export interface UninstallOptions {
  dryRun: boolean
  removeCredentials: boolean
  /** Delete the key store's hmac-master and hmac-legacy and hmac.d/, after restoring hmac.key. */
  removeHmacKeys?: boolean
}

/** Stops the service and removes its config; a service install cannot set up here has neither. */
async function serviceActions(env: InstallEnv): Promise<Action[]> {
  const service = managedServiceOf(env)
  if (service === null) return []
  // A registered service goes even when nothing of it runs: left behind, the OS would start a removed program at every logon.
  const present = (await service.isRegistered?.()) === true || (await service.isRunning())
  const unload: Action[] = present ? [{ kind: 'service', step: 'stop', description: service.describe('stop') }] : []
  const path = service.configPath()
  const remove: Action[] = path !== null && existsSync(path) ? [{ kind: 'remove', path, summary: `the ${service.label}` }] : []
  return [...unload, ...remove]
}

/** The program and its libraries are the install's own files; the rest of the data folder is the user's. */
function installedFilesActions(env: InstallEnv): Action[] {
  const bin = join(env.dataDir, 'bin')
  const lib = join(env.dataDir, 'lib')
  return [
    ...(existsSync(bin) ? [{ kind: 'remove-program-dir', path: bin, summary: 'the installed kinfold program' } as const] : []),
    ...(existsSync(lib) ? [{ kind: 'remove', path: lib, summary: 'the installed sqlite libraries', recursive: true } as const] : []),
  ]
}

function claudeActions(env: InstallEnv): Action[] {
  const path = installPaths(env).claudeSettings
  const file = readJsonObject(path)
  if (!file.exists) return []
  const result = removeSamHooks(file.value)
  if (result.removed === 0) return []
  const backup = plannedBackup(path, env.now())
  return [
    ...(backup !== null ? [{ kind: 'backup', from: path, to: backup } as const] : []),
    { kind: 'write', path, content: serializeJson(result.settings, file.text), mode: file.mode, summary: `remove ${result.removed} Kinfold hook entries; every other key and hook kept` },
  ]
}

function opencodeActions(env: InstallEnv): Action[] {
  const paths = installPaths(env)
  const state = inspectShim(readTextOrNull(paths.opencodePlugin), { pluginEntry: paths.pluginEntry, dataDir: env.dataDir })
  if (state === 'foreign') env.out(`opencode: ${paths.opencodePlugin} is not a Kinfold plugin file; left alone`)
  return state === 'yes' || state === 'stale' ? [{ kind: 'remove', path: paths.opencodePlugin, summary: 'the Kinfold OpenCode plugin file' }] : []
}

/**
 * One host's Kinfold wiring out: its hooks, MCP entry or plugin file, each
 * config backed up beside itself first. Uninstall runs this for every host;
 * install runs it for a host that was wired and is no longer chosen.
 */
export function hostUnwireActions(env: InstallEnv, host: InstallHost): Action[] {
  switch (host) {
    case 'claude-code': return [...claudeActions(env), ...claudeMcpUninstallActions(env)]
    case 'opencode': return [...opencodeActions(env), ...opencodeMcpUninstallActions(env)]
    case 'codex': return codexHookUninstallActions(env)
    case 'cursor': return hostHookUninstallActions(env, 'cursor')
  }
}

/** The default ref plus any ref a stored setting names. A dry run asks the daemon nothing (only /health is allowed). */
async function ourRefs(env: InstallEnv, dryRun: boolean): Promise<string[]> {
  const read = dryRun ? null : await getObserverSettings(env)
  const named = read?.ok === true ? read.view.rows.map((row) => row.credentialRef).filter((ref): ref is string => ref !== null) : []
  return [...new Set([OPENROUTER_CREDENTIAL_REF, ...named])].filter((ref) => !isSystemCredentialRef(ref))
}

function credentialActions(store: KeyStore | null, refs: readonly string[]): Action[] {
  if (store === null) return []
  return refs.filter((ref) => store.exists(ref)).map((ref): Action => secretDeleteAction(store, ref))
}

function keptEntryNote(store: KeyStore, ref: string): string {
  if (store.kind === 'keychain') return `kept keychain entry ${ref}; remove it with: security delete-generic-password -s ${KEYCHAIN_SERVICE} -a ${ref}  (or rerun with --remove-credentials)`
  return `kept ${store.describeEntry(ref)}; rerun with --remove-credentials to remove it`
}

function keptNotes(env: InstallEnv, store: KeyStore | null, refs: readonly string[], removeCredentials: boolean): string[] {
  const notes = [`kept the data dir ${env.dataDir} (memory, spool, logs); remove it with: rm -rf ${env.dataDir}`]
  if (removeCredentials || store === null) return notes
  return [...notes, ...refs.map((ref) => keptEntryNote(store, ref))]
}

/** Uninstall goes on without the keys when the store is unknown: a broken record must not keep the agents wired. */
function unknownStoreNote(reason: string, options: UninstallOptions): string[] {
  const asked = [options.removeCredentials ? '--remove-credentials' : '', options.removeHmacKeys === true ? '--remove-hmac-keys' : ''].filter((flag) => flag !== '')
  const skipped = asked.length > 0 ? `; ${asked.join(' and ')} skipped, no key was deleted` : ''
  return [`key store: unknown (${reason})${skipped}`]
}

export async function uninstall(env: InstallEnv, options: UninstallOptions): Promise<number> {
  try {
    if (platformOf(env).wsl) {
      const code = await wslUninstall(env, options)
      if (code !== null) return code
    }
    const refs = await ourRefs(env, options.dryRun)
    const read = readKeyStore(env)
    const store = read.ok ? read.store : null
    const hmac = read.ok && options.removeHmacKeys === true ? hmacRemoval(env, options.dryRun) : null
    const actions = [
      ...(await serviceActions(env)),
      ...INSTALL_HOSTS.flatMap((host) => hostUnwireActions(env, host)),
      ...(options.removeCredentials ? credentialActions(store, refs) : []),
      ...(hmac?.actions ?? []),
      // Last: until every host entry is gone, each of them still names this program.
      ...installedFilesActions(env),
    ]
    await runPlan(env, actions, options.dryRun)
    const keyNotes = read.ok ? (hmac?.notes ?? hmacKeptNotes(env)) : unknownStoreNote(read.reason, options)
    for (const note of [...keptNotes(env, store, refs, options.removeCredentials), ...keyNotes]) env.out(note)
    const skippedDeletes = !read.ok && (options.removeCredentials || options.removeHmacKeys === true)
    return skippedDeletes ? EXIT_FAILED : EXIT_OK
  } catch (error: unknown) {
    env.out(`uninstall failed: ${errorMessage(error)}`)
    return EXIT_FAILED
  }
}
