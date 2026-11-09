// install and uninstall first build a list of actions, then either print it
// (--dry-run) or print and apply it in order. One list for both is what makes
// a dry run honest: the plan shown is the plan that would run. Descriptions
// carry paths, counts, hosts and argv only; a stored secret prints as
// <hidden>, and a file's content never prints at all.

import { chmodSync, closeSync, mkdirSync, openSync, rmSync } from 'node:fs'
import { HMAC_LEGACY_REF } from '../secrets/hmac-keys'
import { type KeyStoreRecord, keyStoreRecordContent } from '../secrets/key-store-record'
import { KEY_STORE_MODULES } from '../secrets/stores/select'
import type { EmbeddedAssets } from '../runtime/embedded'
import type { ObserverSettingsInput } from '../store/observer-settings-store'
import { START_WAIT_MS, putObserverSettings, waitForHealth, waitForStart } from './daemon-client'
import { createDbKey, createPlainStore, describeCreateDbKey, describeCreatePlainStore } from './db-encryption'
import { type InstallEnv, installPaths } from './env'
import { NOT_FOUND_EXIT } from './system'
import { requireKeyStore } from './key-store-choice'
import { writeBackup, writeFileAtomic } from './files'
import { backupRemovalSummary, removeHmacBackup, removeRedundantBackup, restoreLegacyKey } from './hmac-cleanup'
import { type ModeChange, applyModeChange, describeModeChange } from './permissions'
import { describeEmbeddedSqlite3mcInstall, describeSqlite3mcInstall, installEmbeddedSqlite3mc, installSqlite3mc } from './sqlite3mc-install'
import { describeEmbeddedVec0Install, installEmbeddedVec0, installVec0 } from './vec0-install'
import { CLAUDE_MCP_REMOVE_ARGV, claudeAddArgv, rollbackSafe } from './mcp-wiring'
import { installProgram } from './self-install'
import { leftBehindLine, programFilesOf } from './program-files'
import { checkDaemonDown, copyKeychainEntry, describeCopyKeychainEntry, describeMoveDataDir, describeRemoveLegacyEntry, moveDataDir, removeLegacyEntry, stopLegacyAgent } from './rename-migration'
import { legacyBootoutArgv } from './launch-agent'
import type { Vec0Asset } from '../vectors/vec0-release'
import type { ServiceStep } from './service/control'

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
  /** <dataDir>/bin, through the platform's program files: a file a running program holds is named and left. */
  | { kind: 'remove-program-dir'; path: string; summary: string }
  /** A start or stop through the platform's service; description is its dry-run line, filled at plan time. */
  | { kind: 'service'; step: ServiceStep; description: string }
  /** A host CLI call such as `claude mcp add-json`; argv holds no secret, so it prints whole. */
  | { kind: 'command'; argv: readonly string[]; summary: string; whenMissing?: string }
  /** Swaps our Claude Code MCP entry: remove, add the new one, and put `previous` back if the add fails. Neither entry holds a secret. */
  | { kind: 'claude-mcp-replace'; previous: Record<string, unknown>; next: Record<string, unknown> }
  | { kind: 'wait-takeover'; pid: number | null; port: number }
  | { kind: 'wait-health' }
  | { kind: 'settings-put'; input: ObserverSettingsInput }
  /** description: the store's own dry-run text, filled at plan time; the value prints as <hidden>. */
  | { kind: 'secret-set'; ref: string; value: string; description: string }
  | { kind: 'secret-delete'; ref: string; description: string; summary?: string }
  /** Removed only after a key store read-back and a master-mode /health; else kept with the reason. */
  | { kind: 'remove-hmac-backup'; path: string; storeLabel: string }
  /** hmac.key written back from the key store's hmac-legacy before the HMAC entries go. */
  | { kind: 'restore-hmac-legacy'; path: string; storeLabel: string }
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
  /** The running program copied to <dataDir>/bin, after its release checksum was checked. */
  | { kind: 'install-program'; from: string; to: string; assetName: string | null; expectedSha256: string | null; check: boolean }
  /**
   * db-key for a store the daemon has yet to create, added without replacing any entry: made at run time,
   * or `key`, the one whose recovery code was shown (it prints as <hidden>).
   */
  | { kind: 'create-db-key'; path: string; storeLabel: string; key?: string }
  /** --no-encrypt on a new store: an empty plaintext store, made before the daemon could create it encrypted. */
  | { kind: 'create-plain-store'; path: string }
  /** key-store.json: the store chosen at install, which every later process opens without probing. */
  | { kind: 'record-key-store'; path: string; record: KeyStoreRecord }
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
    case 'remove-program-dir': return `remove ${action.path}/: ${action.summary}`
    case 'service': return action.description
    case 'command': return `${action.summary}: ${action.argv.join(' ')}`
    case 'claude-mcp-replace': return `replace the Kinfold MCP server entry in Claude Code (user scope), putting the old one back if the new one fails: ${CLAUDE_MCP_REMOVE_ARGV.join(' ')}, then ${claudeAddArgv(action.next).join(' ')}`
    case 'wait-takeover': return `wait up to ${TAKEOVER_WAIT_MS / 1000} s for the running daemon on port ${action.port} to stop (you stop it: ${stopCommand(action.pid, action.port)})`
    case 'wait-health': return `wait up to ${START_WAIT_MS / 1000} s for GET /health (a large store takes a while to open)`
    case 'settings-put': {
      const { host, provider, model, credentialRef } = action.input
      return `PUT /observer/settings host=${host} provider=${provider} model=${model} credentialRef=${credentialRef ?? 'none'}`
    }
    case 'secret-set': return action.description
    case 'secret-delete': return `${action.description}${action.summary !== undefined ? `: ${action.summary}` : ''}`
    case 'remove-hmac-backup': return `remove ${action.path}: ${backupRemovalSummary(action.storeLabel)}`
    case 'restore-hmac-legacy': return `write ${action.path} from ${action.storeLabel} entry ${HMAC_LEGACY_REF} (mode 0600), so a later install still verifies epoch-0 refs`
    case 'hmac-daemon-down': return `check that no daemon answers /health on port ${action.port} (a hand-started one must be stopped first: ${stopCommand(action.pid, action.port)})`
    case 'remove-redundant-hmac-backup': return `remove ${action.path} if it equals ${action.legacyPath}: a kept install backup, redundant once hmac.key is back`
    case 'install-vec0': return `download ${action.asset.url} and write its ${action.asset.member} to ${action.path} (mode 0600), after checking both against the pinned sha256`
    case 'install-vec0-embedded': return describeEmbeddedVec0Install(action.path)
    case 'install-sqlite3mc': return describeSqlite3mcInstall(action.path)
    case 'install-sqlite3mc-embedded': return describeEmbeddedSqlite3mcInstall(action.path)
    case 'install-program': {
      const check = action.check ? ` after checking ${action.assetName ?? 'it'} against SHA256SUMS` : ' (checksum check skipped for the development version)'
      return `install program ${action.to} from ${action.from}${check}`
    }
    case 'create-db-key': return describeCreateDbKey(action.storeLabel, action.path, action.key)
    case 'create-plain-store': return describeCreatePlainStore(action.path)
    case 'record-key-store': return `record the key store (${KEY_STORE_MODULES[action.record.store].label}) in ${action.path} (mode 0600)`
    case 'stop-legacy-agent': return `${legacyBootoutArgv(action.uid).join(' ')} (if loaded): stop the daemon installed under the old name`
    case 'migration-daemon-down': return `check that no daemon answers /health on port ${action.port}, waiting up to ${action.waitMs / 1000} s (one still running must be stopped first; nothing is moved while it runs)`
    case 'copy-keychain-entry': return describeCopyKeychainEntry(action.ref)
    case 'move-data-dir': return describeMoveDataDir(action.from, action.to, action.linkOnly === true)
    case 'remove-legacy-keychain-entry': return describeRemoveLegacyEntry(action.ref)
  }
}

/**
 * bootout returns before launchd has finished tearing the job down, and a
 * bootstrap that lands in that window gets exit 5 (EIO). Seen live on the
 * reinstall that rewrote the plist; the job loaded fine moments later.
 */
const BOOTSTRAP_BUSY_EXIT = 5
export const BOOTSTRAP_ATTEMPTS = 10
export const BOOTSTRAP_RETRY_MS = 300

export async function runLaunchctl(env: InstallEnv, argv: readonly string[]): Promise<void> {
  const attempts = argv[1] === 'bootstrap' ? BOOTSTRAP_ATTEMPTS : 1
  let exitCode = 0
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    exitCode = (await env.run({ argv, timeoutMs: 15_000 })).exitCode
    if (exitCode !== BOOTSTRAP_BUSY_EXIT || attempt === attempts) break
    await env.sleep(BOOTSTRAP_RETRY_MS)
  }
  if (exitCode !== 0) throw new Error(`${argv.slice(0, 2).join(' ')} failed (exit ${exitCode})`)
}

/**
 * A host CLI call. One with `whenMissing` is skipped, with that note, when its
 * binary is not installed: removing an agent is the likeliest reason to have
 * dropped its CLI, and every later run would fail the same way otherwise.
 * Only the runner's not-found exit counts; a binary that is there but cannot
 * run is a failure the user has to see.
 */
async function runCommand(env: InstallEnv, action: Extract<Action, { kind: 'command' }>): Promise<void> {
  const { exitCode } = await env.run({ argv: action.argv, timeoutMs: 15_000 })
  if (exitCode === NOT_FOUND_EXIT && action.whenMissing !== undefined) {
    env.out(action.whenMissing)
    return
  }
  if (exitCode !== 0) throw new Error(`${action.argv.slice(0, 2).join(' ')} failed (exit ${exitCode})`)
}

async function replaceClaudeMcp(env: InstallEnv, previous: Record<string, unknown>, next: Record<string, unknown>): Promise<void> {
  if (!rollbackSafe(previous)) throw new Error('the previous Claude Code MCP entry carries env values Kinfold did not write; it was left alone')
  let timedOut = false
  const step = async (argv: readonly string[]): Promise<boolean> => {
    try {
      const result = await env.run({ argv, timeoutMs: 15_000 })
      timedOut = result.timedOut === true
      return result.exitCode === 0
    } catch {
      timedOut = false
      return false
    }
  }
  if (!(await step(CLAUDE_MCP_REMOVE_ARGV))) {
    // A killed remove may or may not have taken effect, so the entry's state is unknown.
    throw new Error(timedOut ? 'claude mcp remove did not finish; check the entry with claude mcp list --scope user' : 'claude mcp remove failed; the previous entry was left in place')
  }
  if (await step(claudeAddArgv(next))) return
  if (await step(claudeAddArgv(previous))) throw new Error('the Claude Code MCP entry could not be replaced; the previous entry was put back')
  throw new Error(`the Claude Code MCP entry could not be replaced and the previous one could not be put back; add it again with: ${claudeAddArgv(previous).join(' ')}`)
}

async function waitFor(env: InstallEnv, wantUp: boolean, timeoutMs: number, failure: string): Promise<void> {
  if (!(await waitForHealth(env, wantUp, timeoutMs))) throw new Error(failure)
}

// Loaded on use: the service module imports this one for HEALTH_WAIT_MS at its top level.
const loadServiceControl = (): Promise<typeof import('./service/control')> => import('./service/control')

async function runServiceStep(env: InstallEnv, step: ServiceStep): Promise<void> {
  const service = (await loadServiceControl()).serviceOf(env)
  if (service === null) throw new Error(`no background service to ${step} on ${env.platform}`)
  return step === 'start' ? service.start() : service.stop()
}

async function waitForDaemonStart(env: InstallEnv): Promise<void> {
  const service = (await loadServiceControl()).serviceOf(env)
  const result = await waitForStart(env, service)
  if (result.ok) return
  const logFile = installPaths(env).logFile
  if (result.reason === 'not-running') throw new Error(`the ${service?.label ?? 'service'} stopped running before the daemon answered /health; the log is ${logFile}`)
  throw new Error(`the daemon did not answer /health within ${START_WAIT_MS / 1000} s; it may still be opening a large store. Run kinfold status in a minute; the log is ${logFile}`)
}

// A file left behind does not fail the step: the agents are unwired by now, so
// it goes once the sessions still running it close.
function removeProgramDir(env: InstallEnv, path: string): void {
  for (const left of programFilesOf(env).removeBinDir(path)) env.out(leftBehindLine(left))
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
    case 'remove-program-dir': return removeProgramDir(env, action.path)
    case 'service': return runServiceStep(env, action.step)
    case 'command': return runCommand(env, action)
    case 'claude-mcp-replace': return replaceClaudeMcp(env, action.previous, action.next)
    case 'wait-takeover':
      env.out(`waiting for you to stop the running daemon: ${stopCommand(action.pid, action.port)}`)
      return waitFor(env, false, TAKEOVER_WAIT_MS, `the daemon on port ${action.port} is still running; nothing after this step ran`)
    case 'wait-health': return waitForDaemonStart(env)
    case 'settings-put': return putObserverSettings(env, action.input)
    case 'secret-set': return requireKeyStore(env).set(action.ref, action.value)
    case 'secret-delete': return void requireKeyStore(env).delete(action.ref)
    case 'remove-hmac-backup': return removeHmacBackup(env, action.path)
    case 'restore-hmac-legacy': return restoreLegacyKey(env, action.path)
    case 'hmac-daemon-down':
      return waitFor(env, false, HEALTH_WAIT_MS, `a daemon still answers /health on port ${action.port}, and it would write a new sub-key after the keys go;`
        + ` stop it (${stopCommand(action.pid, action.port)}) and rerun; no HMAC key was touched`)
    case 'remove-redundant-hmac-backup': return removeRedundantBackup(action.path, action.legacyPath)
    case 'install-vec0': return installVec0(env, action.path, action.asset)
    case 'install-vec0-embedded': return installEmbeddedVec0(env, action.path, action.asset)
    case 'install-sqlite3mc': return installSqlite3mc(env, action.path)
    case 'install-sqlite3mc-embedded': return installEmbeddedSqlite3mc(env, action.path, action.asset)
    case 'install-program': return installProgram(env, action)
    case 'create-db-key': return createDbKey(env, action.path, action.key)
    case 'create-plain-store': return createPlainStore(env, action.path)
    // The folder is flushed too: a record lost in a crash would leave the choice to the missing-record rule.
    case 'record-key-store': return writeFileAtomic(action.path, keyStoreRecordContent(action.record), 0o600, { syncDir: true, fsyncDir: env.fsyncDir, platform: env.platform })
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
