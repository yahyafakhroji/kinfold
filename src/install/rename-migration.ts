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
//   5. the install plan that follows writes the kinfold MCP entries and
//      plugin shim, removes each old one only after its kinfold one is
//      written, and starts dev.kinfold.daemon.
// Nothing is deleted before the rename, so a failed step up to there leaves the
// old install whole (its plist starts it again at login), and a failed install
// step never leaves an agent without a memory entry. Every step checks
// the state it finds, so a rerun after a partial migration finishes the rest
// and a run after a full one plans nothing. Values travel only through
// `security -i` stdin and are compared in memory; descriptions say <hidden>.

import { existsSync, lstatSync, renameSync, symlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { DAEMON_INFO_FILE } from '../store/data-dir'
import { envName } from '../env-names'
import { DATA_DIR_NAME, LEGACY_KEYCHAIN_SERVICE, LEGACY_LAUNCH_AGENT_LABEL, LEGACY_MCP_SERVER_NAME } from '../names'
import { DB_KEY_NEXT_REF, DB_KEY_REF, KEYCHAIN_SERVICE } from '../secrets/credentials'
import { HMAC_LEGACY_REF, HMAC_MASTER_REF } from '../secrets/hmac-keys'
import { readKeychainValue } from '../secrets/keychain'
import { type CredentialWriter, credentialWriterFor } from '../secrets/keychain-writer'
import { checkHealth, readDaemonInfo } from './daemon-client'
import { type InstallEnv, errorMessage, installPaths } from './env'
import { readJsonObject, readTextOrNull } from './files'
import { isAgentLoaded, legacyBootoutArgv, legacyPrintArgv } from './launch-agent'
import { hasOurMcpEntryNamed } from './mcp-config'
import { mcpPaths } from './mcp-wiring'
import { isOwnShim } from './opencode-shim'
import { type Action, TAKEOVER_WAIT_MS } from './plan'

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

/**
 * `claude mcp remove` for the entry under the old name, when it runs our
 * server. The install plan puts it after the kinfold add-json, so Claude Code
 * is never left without a memory server.
 */
export function legacyClaudeMcpRemoval(env: InstallEnv): Action[] {
  const path = mcpPaths(env).claudeUserConfig
  try {
    const file = readJsonObject(path)
    if (!file.exists || !hasOurMcpEntryNamed(file.value, 'claude-code', LEGACY_MCP_SERVER_NAME)) return []
  } catch {
    env.out(`claude-code: ${path} could not be read; a ${LEGACY_MCP_SERVER_NAME} MCP entry in it is left alone`)
    return []
  }
  return [{
    kind: 'command',
    argv: ['claude', 'mcp', 'remove', '--scope', 'user', LEGACY_MCP_SERVER_NAME],
    summary: 'unregister the MCP server under its old name from Claude Code, now that the kinfold one is registered',
  }]
}

/** The plugin shim under its old name, when we wrote it; the install plan puts this after kinfold.js is written. */
export function legacyShimRemoval(env: InstallEnv): Action[] {
  const path = installPaths(env).legacyOpencodePlugin
  const text = readTextOrNull(path)
  if (text === null) return []
  if (!isOwnShim(text)) {
    env.out(`opencode: ${path} is not a plugin shim we wrote; left alone`)
    return []
  }
  return [{ kind: 'remove', path, summary: 'the plugin shim under its old name, now that kinfold.js is in place' }]
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

export interface MigrationOptions {
  /** --takeover: wait as long as the install's takeover wait for a running daemon to stop. */
  takeover?: boolean
}

/**
 * The store and key steps, in order, or none when neither the old data dir,
 * the old LaunchAgent nor an old Keychain entry remains. The old MCP entries
 * and plugin shim are not here: the install plan removes each one after it
 * has written the kinfold one (legacyClaudeMcpRemoval, legacyShimRemoval,
 * and the opencode.json write in mcp-wiring.ts).
 * Throws, before anything changes, when both data dirs exist.
 */
export function renameMigrationActions(env: InstallEnv, options: MigrationOptions = {}): Action[] {
  const paths = installPaths(env)
  const writer = credentialWriterFor(env.platform, env.security)
  const refs = legacyRefs(writer)
  const plist = env.platform === 'darwin' && existsSync(paths.legacyLaunchAgentPlist)
  const move = dataDirMove(env, refs.length > 0 || plist)
  if (!plist && refs.length === 0 && move.length === 0) return []
  const waitMs = options.takeover === true ? TAKEOVER_WAIT_MS : MIGRATION_HEALTH_WAIT_MS
  return [
    ...(plist ? [{ kind: 'stop-legacy-agent', uid: env.uid } as const] : []),
    { kind: 'migration-daemon-down', port: daemonPort(env), waitMs },
    ...refs.map((ref): Action => ({ kind: 'copy-keychain-entry', ref })),
    ...move,
    ...(plist ? [{ kind: 'remove', path: paths.legacyLaunchAgentPlist, summary: 'the LaunchAgent under its old name, stopped above' } as const] : []),
    ...refs.map((ref): Action => ({ kind: 'remove-legacy-keychain-entry', ref })),
  ]
}

/**
 * What a failed migration step leaves running, for its error: before the old
 * plist is removed, launchd starts the old daemon again at login; after, only
 * finishing the migration brings a daemon back.
 */
export function migrationFailureNote(actions: readonly Action[], failedIndex: number): string | null {
  const stopAt = actions.findIndex((action) => action.kind === 'stop-legacy-agent')
  if (stopAt === -1 || failedIndex <= stopAt) return 'rerun kinfold install to finish the migration'
  const plistAt = actions.findIndex((action) => action.kind === 'remove' && action.path.endsWith(`${LEGACY_LAUNCH_AGENT_LABEL}.plist`))
  return failedIndex <= plistAt
    ? 'the old daemon stays stopped until you next log in (its LaunchAgent is still there); rerun kinfold install to finish the migration'
    : 'no daemon runs until the migration finishes; rerun kinfold install to finish it'
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

export async function checkDaemonDown(env: InstallEnv, port: number, waitMs: number = MIGRATION_HEALTH_WAIT_MS): Promise<void> {
  const deadline = env.now() + waitMs
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
    const crossVolume = (error as { code?: unknown } | null)?.code === 'EXDEV'
      ? `; the two paths are on different volumes: move ${from} onto the volume of ${to} yourself, or unset ${envName('DATA_DIR')} so the data dir is ${join(dirname(from), DATA_DIR_NAME)}`
      : ''
    throw new Error(`could not rename ${from} to ${to} (${errorMessage(error)}); nothing was moved or deleted${crossVolume}`)
  }
  try {
    symlinkSync(to, from)
  } catch (error: unknown) {
    throw new Error(`moved ${from} to ${to}, but the link at the old path could not be made (${errorMessage(error)}); rerun install to make it`)
  }
}
