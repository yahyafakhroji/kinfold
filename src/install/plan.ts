// install and uninstall first build a list of actions, then either print it
// (--dry-run) or print and apply it in order. One list for both is what makes
// a dry run honest: the plan shown is the plan that would run. Descriptions
// carry paths, counts, hosts and argv only; a keychain value prints as
// <hidden>, and a file's content never prints at all.

import { chmodSync, closeSync, mkdirSync, openSync, rmSync } from 'node:fs'
import { KEYCHAIN_SERVICE } from '../secrets/credentials'
import { HMAC_LEGACY_REF } from '../secrets/hmac-keys'
import { credentialWriterFor } from '../secrets/keychain-writer'
import type { EmbeddedAssets } from '../runtime/embedded'
import type { ObserverSettingsInput } from '../store/observer-settings-store'
import { putObserverSettings, waitForHealth } from './daemon-client'
import { createDbKey, describeCreateDbKey } from './db-encryption'
import { type InstallEnv, installPaths } from './env'
import { writeBackup, writeFileAtomic } from './files'
import { BACKUP_REMOVAL_SUMMARY, removeHmacBackup, removeRedundantBackup, restoreLegacyKey } from './hmac-cleanup'
import { type ModeChange, applyModeChange, describeModeChange } from './permissions'
import { describeEmbeddedSqlite3mcInstall, describeSqlite3mcInstall, installEmbeddedSqlite3mc, installSqlite3mc } from './sqlite3mc-install'
import { describeEmbeddedVec0Install, installEmbeddedVec0, installVec0 } from './vec0-install'
import { checkDaemonDown, copyKeychainEntry, describeCopyKeychainEntry, describeMoveDataDir, describeRemoveLegacyEntry, moveDataDir, removeLegacyEntry, stopLegacyAgent } from './rename-migration'
import { legacyBootoutArgv } from './launch-agent'
import type { Vec0Asset } from '../vectors/vec0-release'

export const HEALTH_WAIT_MS = 15_000
export const TAKEOVER_WAIT_MS = 300_000

export type Action =
  | { kind: 'mkdir'; path: string; mode: number }
  | { kind: 'chmod'; dataDir: string; change: ModeChange }
  | { kind: 'touch'; path: string; mode: number }
  | { kind: 'backup'; from: string; to: string }
  | { kind: 'write'; path: string; content: string; mode: number; summary: string }
  /** recursive: a directory and everything in it (hmac.d/ on --remove-hmac-keys). */
  | { kind: 'remove'; path: string; summary: string; recursive?: boolean }
  | { kind: 'launchctl'; argv: readonly string[] }
  /** A host CLI call such as `claude mcp add-json`; argv holds no secret, so it prints whole. */
  | { kind: 'command'; argv: readonly string[]; summary: string }
  | { kind: 'wait-takeover'; pid: number | null; port: number }
  | { kind: 'wait-health' }
  | { kind: 'settings-put'; input: ObserverSettingsInput }
  | { kind: 'keychain-put'; ref: string; value: string }
  | { kind: 'keychain-delete'; ref: string; summary?: string }
  /** Removed only after a Keychain read-back and a master-mode /health; else kept with the reason. */
  | { kind: 'remove-hmac-backup'; path: string }
  /** hmac.key written back from Keychain hmac-legacy before the HMAC entries go. */
  | { kind: 'restore-hmac-legacy'; path: string }
  /** --remove-hmac-keys stops here while any daemon answers /health; a hand-started one would write a new sub-key afterwards. */
  | { kind: 'hmac-daemon-down'; pid: number | null; port: number }
  /** A kept install backup, removed only when it equals hmac.key on disk (restored by then); else kept. */
  | { kind: 'remove-redundant-hmac-backup'; path: string; legacyPath: string }
  /** The pinned sqlite-vec build, downloaded and hash-checked twice before it is written. */
  | { kind: 'install-vec0'; path: string; asset: Vec0Asset }
  /** The sqlite-vec build the program carries, checked against its recorded hash before it is written. */
  | { kind: 'install-vec0-embedded'; path: string; asset: EmbeddedAssets['vec0'] }
  /** sqlite3mc built here from the pinned amalgamation; every process opens the store through it. */
  | { kind: 'install-sqlite3mc'; path: string }
  /** The sqlite3mc build the program carries, checked against its recorded hash before it is written. */
  | { kind: 'install-sqlite3mc-embedded'; path: string; asset: EmbeddedAssets['sqlite3mc'] }
  /** db-key for a store the daemon has yet to create, made at run time and added without replacing any entry. */
  | { kind: 'create-db-key'; path: string }
  /** Rename migration: bootout dev.shared-agent-memory.daemon when launchd has it loaded. */
  | { kind: 'stop-legacy-agent'; uid: number }
  /** Rename migration: stops here while any daemon answers /health; it would keep writing to the store being moved. */
  | { kind: 'migration-daemon-down'; port: number; waitMs: number }
  /** Rename migration: the old service's value created under kinfold (never replacing one) and read back equal; a different kinfold value throws. */
  | { kind: 'copy-keychain-entry'; ref: string }
  /** Rename migration: one renameSync, then a symlink at `from` pointing to `to`; linkOnly when the rename ran already. */
  | { kind: 'move-data-dir'; from: string; to: string; linkOnly?: boolean }
  /** Rename migration: the old service's entry deleted, only while the kinfold copy reads back equal. */
  | { kind: 'remove-legacy-keychain-entry'; ref: string }

/** A step that ran but chose to leave something in place, and why. */
export interface StepNote {
  kept: string
}

const octal = (mode: number): string => `0${mode.toString(8)}`

export function stopCommand(pid: number | null, port: number): string {
  return pid !== null ? `kill ${pid}` : `lsof -nP -iTCP:${port} -sTCP:LISTEN   # then kill the pid it shows`
}

export function describeAction(action: Action): string {
  switch (action.kind) {
    case 'mkdir': return `mkdir ${action.path} (mode ${octal(action.mode)})`
    case 'chmod': return `chmod <dataDir>/${describeModeChange(action.change)}`
    case 'touch': return `create ${action.path} if missing (mode ${octal(action.mode)})`
    case 'backup': return `back up ${action.from} -> ${action.to} (mode 0600)`
    case 'write': return `write ${action.path}: ${action.summary}`
    case 'remove': return `remove ${action.path}${action.recursive === true ? '/' : ''}: ${action.summary}`
    case 'launchctl': return action.argv.join(' ')
    case 'command': return `${action.summary}: ${action.argv.join(' ')}`
    case 'wait-takeover': return `wait up to ${TAKEOVER_WAIT_MS / 1000} s for the running daemon on port ${action.port} to stop (you stop it: ${stopCommand(action.pid, action.port)})`
    case 'wait-health': return `wait up to ${HEALTH_WAIT_MS / 1000} s for GET /health`
    case 'settings-put': {
      const { host, provider, model, credentialRef } = action.input
      return `PUT /observer/settings host=${host} provider=${provider} model=${model} credentialRef=${credentialRef ?? 'none'}`
    }
    case 'keychain-put': return `keychain: /usr/bin/security -i <<< "add-generic-password -U -s ${KEYCHAIN_SERVICE} -a ${action.ref} -w <hidden>"`
    case 'keychain-delete': return `keychain: /usr/bin/security delete-generic-password -s ${KEYCHAIN_SERVICE} -a ${action.ref}${action.summary !== undefined ? `: ${action.summary}` : ''}`
    case 'remove-hmac-backup': return `remove ${action.path}: ${BACKUP_REMOVAL_SUMMARY}`
    case 'restore-hmac-legacy': return `write ${action.path} from keychain entry ${HMAC_LEGACY_REF} (mode 0600), so a later install still verifies epoch-0 refs`
    case 'hmac-daemon-down': return `check that no daemon answers /health on port ${action.port} (a hand-started one must be stopped first: ${stopCommand(action.pid, action.port)})`
    case 'remove-redundant-hmac-backup': return `remove ${action.path} if it equals ${action.legacyPath}: a kept install backup, redundant once hmac.key is back`
    case 'install-vec0': return `download ${action.asset.url} and write its ${action.asset.member} to ${action.path} (mode 0600), after checking both against the pinned sha256`
    case 'install-vec0-embedded': return describeEmbeddedVec0Install(action.path)
    case 'install-sqlite3mc': return describeSqlite3mcInstall(action.path)
    case 'install-sqlite3mc-embedded': return describeEmbeddedSqlite3mcInstall(action.path)
    case 'create-db-key': return describeCreateDbKey(action.path)
    case 'stop-legacy-agent': return `${legacyBootoutArgv(action.uid).join(' ')} (if loaded): stop the daemon installed under the old name`
    case 'migration-daemon-down': return `check that no daemon answers /health on port ${action.port}, waiting up to ${action.waitMs / 1000} s (one still running must be stopped first; nothing is moved while it runs)`
    case 'copy-keychain-entry': return describeCopyKeychainEntry(action.ref)
    case 'move-data-dir': return describeMoveDataDir(action.from, action.to, action.linkOnly === true)
    case 'remove-legacy-keychain-entry': return describeRemoveLegacyEntry(action.ref)
  }
}

function writer(env: InstallEnv): NonNullable<ReturnType<typeof credentialWriterFor>> {
  const found = credentialWriterFor(env.platform, env.security)
  if (found === null) throw new Error(`no keychain on ${env.platform}; credentials are not stored`)
  return found
}

/**
 * bootout returns before launchd has finished tearing the job down, and a
 * bootstrap that lands in that window gets exit 5 (EIO). Seen live on the
 * reinstall that rewrote the plist; the job loaded fine moments later.
 */
const BOOTSTRAP_BUSY_EXIT = 5
export const BOOTSTRAP_ATTEMPTS = 10
export const BOOTSTRAP_RETRY_MS = 300

async function runLaunchctl(env: InstallEnv, argv: readonly string[]): Promise<void> {
  const attempts = argv[1] === 'bootstrap' ? BOOTSTRAP_ATTEMPTS : 1
  let exitCode = 0
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    exitCode = (await env.run({ argv, timeoutMs: 15_000 })).exitCode
    if (exitCode !== BOOTSTRAP_BUSY_EXIT || attempt === attempts) break
    await env.sleep(BOOTSTRAP_RETRY_MS)
  }
  if (exitCode !== 0) throw new Error(`${argv.slice(0, 2).join(' ')} failed (exit ${exitCode})`)
}

async function waitFor(env: InstallEnv, wantUp: boolean, timeoutMs: number, failure: string): Promise<void> {
  if (!(await waitForHealth(env, wantUp, timeoutMs))) throw new Error(failure)
}

function touch(path: string, mode: number): void {
  closeSync(openSync(path, 'a', mode))
  chmodSync(path, mode)
}

export async function applyAction(env: InstallEnv, action: Action): Promise<StepNote | void> {
  switch (action.kind) {
    case 'mkdir': return void (mkdirSync(action.path, { recursive: true, mode: action.mode }), chmodSync(action.path, action.mode))
    case 'chmod': return applyModeChange(action.dataDir, action.change)
    case 'touch': return touch(action.path, action.mode)
    case 'backup': return writeBackup(action.from, action.to)
    case 'write': return writeFileAtomic(action.path, action.content, action.mode)
    case 'remove': return rmSync(action.path, { force: true, recursive: action.recursive === true })
    case 'launchctl': return runLaunchctl(env, action.argv)
    case 'command': return runLaunchctl(env, action.argv)
    case 'wait-takeover':
      env.out(`waiting for you to stop the running daemon: ${stopCommand(action.pid, action.port)}`)
      return waitFor(env, false, TAKEOVER_WAIT_MS, `the daemon on port ${action.port} is still running; nothing after this step ran`)
    case 'wait-health': return waitFor(env, true, HEALTH_WAIT_MS, `the daemon did not answer /health; see ${installPaths(env).logFile}`)
    case 'settings-put': return putObserverSettings(env, action.input)
    case 'keychain-put': return writer(env).put(action.ref, action.value)
    case 'keychain-delete': return void writer(env).remove(action.ref)
    case 'remove-hmac-backup': return removeHmacBackup(env, action.path)
    case 'restore-hmac-legacy': return restoreLegacyKey(env, action.path)
    case 'hmac-daemon-down':
      return waitFor(env, false, HEALTH_WAIT_MS, `a daemon still answers /health on port ${action.port}, and it would write a new sub-key after the keys go;`
        + ` stop it (${stopCommand(action.pid, action.port)}) and rerun; no HMAC key was touched`)
    case 'remove-redundant-hmac-backup': return removeRedundantBackup(action.path, action.legacyPath)
    case 'install-vec0': return installVec0(env, action.path, action.asset)
    case 'install-vec0-embedded': return installEmbeddedVec0(env, action.path, action.asset)
    case 'install-sqlite3mc': return installSqlite3mc(env, action.path)
    case 'install-sqlite3mc-embedded': return installEmbeddedSqlite3mc(env, action.asset)
    case 'create-db-key': return createDbKey(env, action.path)
    case 'stop-legacy-agent': return stopLegacyAgent(env)
    case 'migration-daemon-down': return checkDaemonDown(env, action.port, action.waitMs)
    case 'copy-keychain-entry': return copyKeychainEntry(env, action.ref)
    case 'move-data-dir': return moveDataDir(env, action.from, action.to)
    case 'remove-legacy-keychain-entry': return removeLegacyEntry(env, action.ref)
  }
}

/**
 * Prints the plan; unless dry, applies it step by step and stops at the first failure, naming the step.
 * failureNote adds what the failure leaves behind (the rename migration says which daemon still runs).
 */
export async function runPlan(env: InstallEnv, actions: readonly Action[], dryRun: boolean, failureNote?: (index: number) => string | null): Promise<void> {
  if (actions.length === 0) {
    env.out(dryRun ? 'plan: nothing to change' : 'nothing to change')
    return
  }
  env.out(dryRun ? `plan (dry run, nothing is changed): ${actions.length} actions` : `applying ${actions.length} actions`)
  for (const [index, action] of actions.entries()) {
    const line = `  ${index + 1}. ${describeAction(action)}`
    if (dryRun) {
      env.out(line)
      continue
    }
    try {
      const note = await applyAction(env, action)
      const kept = note ? note.kept : null
      env.out(`${line}  [${kept === null ? 'done' : 'kept'}]`)
      if (kept !== null) env.out(`     ${kept}`)
    } catch (error: unknown) {
      env.out(`${line}  [failed]`)
      const note = failureNote?.(index) ?? null
      throw new Error(`step ${index + 1} failed: ${error instanceof Error ? error.message : String(error)}${note === null ? '' : `; ${note}`}`)
    }
  }
}
