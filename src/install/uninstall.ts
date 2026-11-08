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

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { KEYCHAIN_SERVICE, isSystemCredentialRef } from '../secrets/credentials'
import { credentialWriterFor } from '../secrets/keychain-writer'
import { OPENROUTER_CREDENTIAL_REF } from '../observer/settings'
import { removeSamHooks } from './claude-hooks'
import { getObserverSettings } from './daemon-client'
import { type InstallEnv, errorMessage, installPaths } from './env'
import { plannedBackup, readJsonObject, readTextOrNull, serializeJson } from './files'
import { EXIT_FAILED, EXIT_OK } from './install'
import { bootoutArgv, isAgentLoaded } from './launch-agent'
import { claudeMcpUninstallActions, opencodeMcpUninstallActions } from './mcp-wiring'
import { hmacRemoval } from './hmac-cleanup'
import { hmacKeptNotes } from './hmac-migration'
import { codexHookUninstallActions, hostHookUninstallActions } from './host-wiring'
import { inspectShim } from './opencode-shim'
import { type Action, runPlan } from './plan'

export interface UninstallOptions {
  dryRun: boolean
  removeCredentials: boolean
  /** Delete Keychain hmac-master and hmac-legacy and hmac.d/, after restoring hmac.key. */
  removeHmacKeys?: boolean
}

async function launchAgentActions(env: InstallEnv): Promise<Action[]> {
  const paths = installPaths(env)
  const unload: Action[] = (await isAgentLoaded(env)) ? [{ kind: 'launchctl', argv: bootoutArgv(env.uid) }] : []
  const remove: Action[] = existsSync(paths.launchAgentPlist) ? [{ kind: 'remove', path: paths.launchAgentPlist, summary: 'the LaunchAgent' }] : []
  return [...unload, ...remove]
}

/** The program and its libraries are the install's own files; the rest of the data folder is the user's. */
function installedFilesActions(env: InstallEnv): Action[] {
  const bin = join(env.dataDir, 'bin')
  const lib = join(env.dataDir, 'lib')
  return [
    ...(existsSync(bin) ? [{ kind: 'remove', path: bin, summary: 'the installed kinfold program', recursive: true } as const] : []),
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

/** The default ref plus any ref a stored setting names. A dry run asks the daemon nothing (only /health is allowed). */
async function ourRefs(env: InstallEnv, dryRun: boolean): Promise<string[]> {
  const read = dryRun ? null : await getObserverSettings(env)
  const named = read?.ok === true ? read.view.rows.map((row) => row.credentialRef).filter((ref): ref is string => ref !== null) : []
  return [...new Set([OPENROUTER_CREDENTIAL_REF, ...named])].filter((ref) => !isSystemCredentialRef(ref))
}

function credentialActions(env: InstallEnv, refs: readonly string[]): Action[] {
  const writer = credentialWriterFor(env.platform, env.security)
  if (writer === null) return []
  return refs.filter((ref) => writer.exists(ref)).map((ref): Action => ({ kind: 'keychain-delete', ref }))
}

function keptNotes(env: InstallEnv, refs: readonly string[], removeCredentials: boolean): string[] {
  const notes = [`kept the data dir ${env.dataDir} (memory, spool, logs); remove it with: rm -rf ${env.dataDir}`]
  if (removeCredentials) return notes
  return [...notes, ...refs.map((ref) => `kept keychain entry ${ref}; remove it with: security delete-generic-password -s ${KEYCHAIN_SERVICE} -a ${ref}  (or rerun with --remove-credentials)`)]
}

export async function uninstall(env: InstallEnv, options: UninstallOptions): Promise<number> {
  try {
    const refs = await ourRefs(env, options.dryRun)
    const hmac = options.removeHmacKeys === true ? hmacRemoval(env, options.dryRun) : null
    const actions = [
      ...(await launchAgentActions(env)),
      ...claudeActions(env),
      ...claudeMcpUninstallActions(env),
      ...opencodeActions(env),
      ...opencodeMcpUninstallActions(env),
      ...codexHookUninstallActions(env),
      ...hostHookUninstallActions(env, 'cursor'),
      ...(options.removeCredentials ? credentialActions(env, refs) : []),
      ...(hmac?.actions ?? []),
      // Last: until every host entry is gone, each of them still names this program.
      ...installedFilesActions(env),
    ]
    await runPlan(env, actions, options.dryRun)
    for (const note of [...keptNotes(env, refs, options.removeCredentials), ...(hmac?.notes ?? hmacKeptNotes(env))]) env.out(note)
    return EXIT_OK
  } catch (error: unknown) {
    env.out(`uninstall failed: ${errorMessage(error)}`)
    return EXIT_FAILED
  }
}
