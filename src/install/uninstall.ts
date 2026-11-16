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
// What the PATH step added goes too (the ~/.local/bin link, the marked block,
// the Windows PATH entry), and install.json forgets that choice, so a later
// install asks again. On a terminal the plan runs behind a progress bar and
// ends with what was kept; elsewhere it prints the lines it always printed.
// Both write them to logs/install.log.

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { KEYCHAIN_SERVICE, isSystemCredentialRef } from '../secrets/credentials'
import type { KeyStore } from '../secrets/key-store'
import { DEFAULT_CREDENTIAL_REFS, OPENAI_COMPATIBLE_CREDENTIAL_REF } from '../observer/settings'
import { getObserverSettings } from './daemon-client'
import { type InstallEnv, errorMessage, platformOf } from './env'
import { EXIT_BLOCKED, EXIT_FAILED, EXIT_OK, type InstallOptions, takeInstallLock } from './install'
import { pathRemovalActions } from './path-setup'
import { uiFor } from './prompt/ui'
import { INSTALL_RECORD_FILE, type InstallRecord, readInstallRecord } from './setup/record'
import { STAGE_DIR } from '../update/stage'
import { DASHBOARD_SESSIONS_FILE } from '../dashboard/auth'
import { openSession } from './setup/session'
import { VERSION } from '../version'
import { INSTALL_HOSTS, type InstallHost } from './detect'
import { hmacRemoval } from './hmac-cleanup'
import { hmacKeptNotes } from './hmac-migration'
import { readKeyStore, secretDeleteAction } from './key-store-choice'
import { type Action, linesListener, runPlan, shortLabel } from './plan'
import { managedServiceOf } from './service/control'
import { wslUninstall } from '../wsl/entry'
import { profileOf } from '../agents/install-profiles'

export interface UninstallOptions {
  dryRun: boolean
  removeCredentials: boolean
  /** Delete the key store's hmac-master and hmac-legacy and hmac.d/, after restoring hmac.key. */
  removeHmacKeys?: boolean
  /** On a terminal, show each numbered step above the progress bar. */
  verbose?: boolean
  /** Test seams for the update lock. */
  lock?: InstallOptions['lock']
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
  const sidecar = service.sidecar?.()?.path ?? null
  const removeSidecar: Action[] = sidecar !== null && existsSync(sidecar) ? [{ kind: 'remove', path: sidecar, summary: `the ${service.label}'s PATH file` }] : []
  return [...unload, ...remove, ...removeSidecar]
}

/** The program and its libraries are the install's own files; the rest of the data folder is the user's. */
function installedFilesActions(env: InstallEnv): Action[] {
  const bin = join(env.dataDir, 'bin')
  const lib = join(env.dataDir, 'lib')
  // A release staged for the user's yes is a program too, and only an install could ever run it.
  const staged = join(env.dataDir, STAGE_DIR)
  // Dashboard sign-ins belong to this install; a later install starts signed out.
  const sessions = join(env.dataDir, DASHBOARD_SESSIONS_FILE)
  return [
    ...(existsSync(bin) ? [{ kind: 'remove-program-dir', path: bin, summary: 'the installed kinfold program' } as const] : []),
    ...(existsSync(lib) ? [{ kind: 'remove', path: lib, summary: 'the installed sqlite libraries', recursive: true } as const] : []),
    ...(existsSync(staged) ? [{ kind: 'remove', path: staged, summary: 'the downloaded release waiting to be installed', recursive: true } as const] : []),
    ...(existsSync(sessions) ? [{ kind: 'remove', path: sessions, summary: 'the dashboard sign-ins' } as const] : []),
  ]
}

/**
 * One host's Kinfold wiring out: its hooks, MCP entry or plugin file, each
 * config backed up beside itself first. Uninstall runs this for every host;
 * install runs it for a host that was wired and is no longer chosen.
 */
export function hostUnwireActions(env: InstallEnv, host: InstallHost): Action[] {
  return profileOf(host).wiring.uninstall(env)
}

/** Every ref setup can write, plus any ref a stored setting names; only those present are removed. A dry run asks the daemon nothing (only /health is allowed). */
async function ourRefs(env: InstallEnv, dryRun: boolean): Promise<string[]> {
  const read = dryRun ? null : await getObserverSettings(env)
  const named = read?.ok === true ? read.view.rows.map((row) => row.credentialRef).filter((ref): ref is string => ref !== null) : []
  return [...new Set([...Object.values(DEFAULT_CREDENTIAL_REFS), OPENAI_COMPATIBLE_CREDENTIAL_REF, ...named])].filter((ref) => !isSystemCredentialRef(ref))
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

/** install.json without the PATH choice, so the next install asks again; none when there is nothing to forget. */
function forgetPathActions(env: InstallEnv, saved: InstallRecord | null): Action[] {
  if (saved === null || saved.pathSetup === undefined) return []
  const { pathSetup: _setup, pathLink: _link, pathFiles: _files, ...record } = saved
  return [{ kind: 'install-record', path: join(env.dataDir, INSTALL_RECORD_FILE), dataDir: env.dataDir, record, summary: 'forget how the kinfold command was set up, so a later install asks again' }]
}

export async function uninstall(base: InstallEnv, options: UninstallOptions): Promise<number> {
  // Uninstall asks nothing, so there is no --yes to make it plain: a terminal is framed, anything else is not.
  const ui = await uiFor(base, { yes: false })
  const session = openSession(base, ui, 'uninstall', { dryRun: options.dryRun, verbose: options.verbose ?? false })
  const env = session.env
  ui.output.intro(`Kinfold ${VERSION} uninstall`)
  const end = (code: number): number => {
    if (code === EXIT_OK) session.view?.finish('', [], options.dryRun ? 'Dry run: nothing was changed.' : 'Done.')
    else session.view?.fail('uninstall did not finish')
    return code
  }
  try {
    if (platformOf(env).wsl) {
      const code = await wslUninstall(env, options)
      if (code !== null) return end(code)
    }
    const refs = await ourRefs(env, options.dryRun)
    const read = readKeyStore(env)
    const store = read.ok ? read.store : null
    const hmac = read.ok && options.removeHmacKeys === true ? hmacRemoval(env, options.dryRun) : null
    const saved = readInstallRecord(env.dataDir)
    // Each part with the bar's words for it; null leaves every action its own short label.
    const parts: [string | null, Action[]][] = [
      [null, await serviceActions(env)],
      ...INSTALL_HOSTS.map((host): [string, Action[]] => [`unwiring ${profileOf(host).name}`, hostUnwireActions(env, host)]),
      [null, options.removeCredentials ? credentialActions(store, refs) : []],
      [null, hmac?.actions ?? []],
      ['removing the kinfold command', [...pathRemovalActions(env, saved), ...forgetPathActions(env, saved)]],
      // Last: until every host entry is gone, each of them still names this program.
      [null, installedFilesActions(env)],
    ]
    const actions = parts.flatMap(([, part]) => part)
    const labels = parts.flatMap(([label, part]) => part.map((action) => label ?? shortLabel(action)))
    // From here the bar draws; what each step says goes to the log.
    const lock = takeInstallLock(env, options, 'uninstall')
    if (lock === 'blocked') return end(EXIT_BLOCKED)
    session.hideLines()
    try {
      await runPlan(env, actions, options.dryRun, undefined, { listeners: [linesListener(env.out), ...session.planListeners], labels })
    } finally {
      lock.release()
    }
    const keyNotes = read.ok ? (hmac?.notes ?? hmacKeptNotes(env)) : unknownStoreNote(read.reason, options)
    const notes = [...keptNotes(env, store, refs, options.removeCredentials), ...keyNotes]
    for (const note of notes) env.out(note)
    const skippedDeletes = !read.ok && (options.removeCredentials || options.removeHmacKeys === true)
    // On a terminal the notes went to the log; a run that ends as failed has to show why.
    if (skippedDeletes) for (const note of keyNotes) session.view?.note(note)
    if (options.dryRun || skippedDeletes) return end(skippedDeletes ? EXIT_FAILED : EXIT_OK)
    session.view?.finish('Uninstalled', notes.map((text) => ({ mark: 'none' as const, text })), `Kinfold is removed. Your memory is still in ${env.dataDir}.`)
    return EXIT_OK
  } catch (error: unknown) {
    session.fail(`uninstall failed: ${errorMessage(error)}`)
    return EXIT_FAILED
  } finally {
    session.flush()
  }
}
