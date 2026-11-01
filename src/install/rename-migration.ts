// The one-time move of a Shared Agent Memory install to the Kinfold names, run
// by `kinfold install` before anything else is planned:
//   1. stop dev.shared-agent-memory.daemon, and refuse while any daemon still
//      answers /health (it would keep writing to the store being moved);
//   2. copy each Keychain entry from service shared-agent-memory to kinfold,
//      never replacing an entry, and read the copy back; a kinfold entry that
//      already holds a different value stops the migration;
//   3. rename ~/.shared-agent-memory to ~/.kinfold (one rename, same volume)
//      and leave a symlink at the old path for processes still on old code;
//   4. remove the old plist, then each old Keychain entry, each only after its
//      kinfold copy reads back equal again;
//   5. remove the old MCP entries and plugin shim; the install steps that
//      follow write the kinfold ones and start dev.kinfold.daemon.
// Nothing is deleted before the rename, so a failed step up to there leaves the
// old install whole (its plist starts it again at login). Every step checks
// the state it finds, so a rerun after a partial migration finishes the rest
// and a run after a full one plans nothing. Values travel only through
// `security -i` stdin and are compared in memory; descriptions say <hidden>.

import { existsSync, lstatSync, renameSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { DAEMON_INFO_FILE } from '../store/data-dir'
import { LEGACY_KEYCHAIN_SERVICE, LEGACY_MCP_SERVER_NAME } from '../names'
import { DB_KEY_NEXT_REF, DB_KEY_REF, KEYCHAIN_SERVICE } from '../secrets/credentials'
import { HMAC_LEGACY_REF, HMAC_MASTER_REF } from '../secrets/hmac-keys'
import { readKeychainValue } from '../secrets/keychain'
import { type CredentialWriter, credentialWriterFor } from '../secrets/keychain-writer'
import { checkHealth, readDaemonInfo } from './daemon-client'
import type { InstallHost } from './detect'
import { type InstallEnv, errorMessage, installPaths } from './env'
import { plannedBackup, readJsonObject, readTextOrNull, serializeJson } from './files'
import { isAgentLoaded, legacyBootoutArgv, legacyPrintArgv } from './launch-agent'
import { hasOurMcpEntryNamed, removeMcpEntryNamed } from './mcp-config'
import { mcpPaths } from './mcp-wiring'
import { isOwnShim } from './opencode-shim'
import type { Action } from './plan'

/** Every entry a pre-rename install could hold; the migration copies the ones it finds. */
export const LEGACY_KEYCHAIN_REFS: readonly string[] = ['openrouter', HMAC_MASTER_REF, HMAC_LEGACY_REF, DB_KEY_REF, DB_KEY_NEXT_REF]

export const MIGRATION_HEALTH_WAIT_MS = 15_000
const HEALTH_POLL_MS = 250

type PathKind = 'missing' | 'dir' | 'symlink' | 'other'

function pathKind(path: string): PathKind {
  try {
    const stat = lstatSync(path)
    return stat.isSymbolicLink() ? 'symlink' : stat.isDirectory() ? 'dir' : 'other'
  } catch {
    return 'missing'
  }
}

function legacyRefs(writer: CredentialWriter | null): string[] {
  return writer === null ? [] : LEGACY_KEYCHAIN_REFS.filter((ref) => writer.legacy.exists(ref))
}

function claudeLegacyMcp(env: InstallEnv): Action[] {
  const path = mcpPaths(env).claudeUserConfig
  try {
    const file = readJsonObject(path)
    if (!file.exists || !hasOurMcpEntryNamed(file.value, 'claude-code', LEGACY_MCP_SERVER_NAME)) return []
  } catch {
    env.out(`migration: ${path} could not be read; a ${LEGACY_MCP_SERVER_NAME} MCP entry in it is left alone`)
    return []
  }
  return [{
    kind: 'command',
    argv: ['claude', 'mcp', 'remove', '--scope', 'user', LEGACY_MCP_SERVER_NAME],
    summary: 'unregister the MCP server under its old name from Claude Code',
  }]
}

function opencodeLegacyMcp(env: InstallEnv): Action[] {
  const path = mcpPaths(env).opencodeConfig
  const file = readJsonObject(path)
  if (!file.exists || !hasOurMcpEntryNamed(file.value, 'opencode', LEGACY_MCP_SERVER_NAME)) return []
  const removed = removeMcpEntryNamed(file.value, 'opencode', LEGACY_MCP_SERVER_NAME)
  const backup = plannedBackup(path, env.now())
  return [
    ...(backup !== null ? [{ kind: 'backup', from: path, to: backup } as const] : []),
    { kind: 'write', path, content: serializeJson(removed.config, file.text), mode: file.mode, summary: `remove the MCP server under its old name ${LEGACY_MCP_SERVER_NAME}; every other key kept` },
  ]
}

function legacyShim(env: InstallEnv): Action[] {
  const path = installPaths(env).legacyOpencodePlugin
  const text = readTextOrNull(path)
  if (text === null) return []
  if (!isOwnShim(text)) {
    env.out(`migration: ${path} is not a plugin shim we wrote; left alone`)
    return []
  }
  return [{ kind: 'remove', path, summary: 'the plugin shim under its old name' }]
}

/** The old data dir move: none, a rename then a link, or only the link (a run stopped between the two). */
function dataDirMove(env: InstallEnv, otherWorkPending: boolean): Action[] {
  const from = installPaths(env).legacyDataDir
  if (from === env.dataDir) return []
  const legacy = pathKind(from)
  const current = pathKind(env.dataDir)
  if (legacy === 'dir' && current !== 'missing') {
    throw new Error(`both ${from} and ${env.dataDir} exist; kinfold will not merge them. Move one of them away and rerun; nothing was changed`)
  }
  if (legacy === 'dir') return [{ kind: 'move-data-dir', from, to: env.dataDir }]
  if (legacy === 'missing' && current === 'dir' && otherWorkPending) return [{ kind: 'move-data-dir', from, to: env.dataDir, linkOnly: true }]
  return []
}

/** The port a still-running daemon would answer on: daemon.json in the old dir, else the new one, else the default. */
function daemonPort(env: InstallEnv): number {
  const legacyDir = installPaths(env).legacyDataDir
  return readDaemonInfo(existsSync(join(legacyDir, DAEMON_INFO_FILE)) ? legacyDir : env.dataDir).port
}

/**
 * The migration steps, in order, or none when nothing of a pre-rename install
 * remains. `hosts` limits the MCP and shim steps to the hosts being installed,
 * so an entry is never removed without the kinfold one written after it.
 * Throws, before anything changes, when both data dirs exist.
 */
export function renameMigrationActions(env: InstallEnv, hosts: readonly InstallHost[] = ['claude-code', 'opencode']): Action[] {
  const paths = installPaths(env)
  const writer = credentialWriterFor(env.platform, env.security)
  const refs = legacyRefs(writer)
  const plist = env.platform === 'darwin' && existsSync(paths.legacyLaunchAgentPlist)
  const wiring = [
    ...(hosts.includes('claude-code') ? claudeLegacyMcp(env) : []),
    ...(hosts.includes('opencode') ? [...opencodeLegacyMcp(env), ...legacyShim(env)] : []),
  ]
  const move = dataDirMove(env, refs.length > 0 || plist || wiring.length > 0)
  // Stopping the old daemon matters only to the store and key steps; old wiring alone never waits on it.
  const core = plist || refs.length > 0 || move.length > 0
  if (!core && wiring.length === 0) return []
  return [
    ...(plist ? [{ kind: 'stop-legacy-agent', uid: env.uid } as const] : []),
    ...(core ? [{ kind: 'migration-daemon-down', port: daemonPort(env) } as const] : []),
    ...refs.map((ref): Action => ({ kind: 'copy-keychain-entry', ref })),
    ...move,
    ...(plist ? [{ kind: 'remove', path: paths.legacyLaunchAgentPlist, summary: 'the LaunchAgent under its old name, stopped above' } as const] : []),
    ...refs.map((ref): Action => ({ kind: 'remove-legacy-keychain-entry', ref })),
    ...wiring,
  ]
}

export function describeMoveDataDir(from: string, to: string, linkOnly: boolean): string {
  return linkOnly
    ? `link ${from} -> ${to}: the data dir was moved already, the link at the old path was not made`
    : `move ${from} -> ${to} (one rename, same volume), then link ${from} -> ${to} so processes on the old code still find the store`
}

export function describeCopyKeychainEntry(ref: string): string {
  return `keychain: copy ${ref} from service ${LEGACY_KEYCHAIN_SERVICE} to ${KEYCHAIN_SERVICE} (value <hidden>), never replacing an entry, then read it back and compare`
}

export function describeRemoveLegacyEntry(ref: string): string {
  return `keychain: /usr/bin/security delete-generic-password -s ${LEGACY_KEYCHAIN_SERVICE} -a ${ref}, only once the ${KEYCHAIN_SERVICE} copy reads back equal`
}

function keychainWriter(env: InstallEnv): CredentialWriter {
  const writer = credentialWriterFor(env.platform, env.security)
  if (writer === null) throw new Error(`no keychain on ${env.platform}`)
  return writer
}

/** The value under kinfold only, with no fallback to the old service. */
function currentValue(env: InstallEnv, ref: string): string | null {
  return readKeychainValue((args) => env.security({ args }), ref, KEYCHAIN_SERVICE)
}

export async function stopLegacyAgent(env: InstallEnv): Promise<void> {
  if (!(await isAgentLoaded(env, legacyPrintArgv(env.uid)))) return
  const { exitCode } = await env.run({ argv: legacyBootoutArgv(env.uid), timeoutMs: 15_000 })
  if (exitCode !== 0) throw new Error(`launchctl bootout of the old LaunchAgent failed (exit ${exitCode}); nothing was moved`)
}

export async function checkDaemonDown(env: InstallEnv, port: number): Promise<void> {
  const deadline = env.now() + MIGRATION_HEALTH_WAIT_MS
  for (;;) {
    if (!(await checkHealth(env, port)).up) return
    if (env.now() >= deadline) {
      throw new Error(`a daemon still answers /health on port ${port} and would keep writing to the store; stop it (lsof -nP -iTCP:${port} -sTCP:LISTEN, then kill the pid) and rerun; nothing was moved`)
    }
    await env.sleep(HEALTH_POLL_MS)
  }
}

/** Copies one entry to kinfold; an equal copy already there is fine, a different one stops everything. */
export function copyKeychainEntry(env: InstallEnv, ref: string): void {
  const writer = keychainWriter(env)
  const value = writer.legacy.read(ref)
  if (value === null) throw new Error(`keychain entry ${ref} under ${LEGACY_KEYCHAIN_SERVICE} is gone or empty; nothing was deleted`)
  const existing = currentValue(env, ref)
  if (existing !== null && existing !== value) {
    throw new Error(`keychain entry ${ref} under ${KEYCHAIN_SERVICE} holds a different value than under ${LEGACY_KEYCHAIN_SERVICE}; kinfold keeps both and deletes nothing. Decide which one is right and remove the other by hand, then rerun`)
  }
  if (existing === null) writer.create(ref, value)
  if (currentValue(env, ref) !== value) throw new Error(`keychain entry ${ref} under ${KEYCHAIN_SERVICE} did not read back equal after the copy; nothing was deleted`)
}

/** Deletes the old entry only while the kinfold copy reads back equal; an old entry already gone is fine. */
export function removeLegacyEntry(env: InstallEnv, ref: string): void {
  const writer = keychainWriter(env)
  const value = writer.legacy.read(ref)
  if (value === null) return
  if (currentValue(env, ref) !== value) throw new Error(`keychain entry ${ref} under ${KEYCHAIN_SERVICE} does not match the old one; the old entry was kept`)
  writer.legacy.remove(ref)
}

export function moveDataDir(env: InstallEnv, from: string, to: string): void {
  const legacy = pathKind(from)
  const current = pathKind(to)
  if (legacy === 'missing' && current === 'dir') return symlinkSync(to, from)
  if (legacy !== 'dir') throw new Error(`${from} is no longer a directory; nothing was moved`)
  if (current !== 'missing') throw new Error(`${to} appeared while install ran; nothing was moved`)
  const rename = env.renameDir ?? renameSync
  try {
    rename(from, to)
  } catch (error: unknown) {
    throw new Error(`could not rename ${from} to ${to} (${errorMessage(error)}); nothing was moved or deleted`)
  }
  try {
    symlinkSync(to, from)
  } catch (error: unknown) {
    throw new Error(`moved ${from} to ${to}, but the link at the old path could not be made (${errorMessage(error)}); rerun install to make it`)
  }
}
