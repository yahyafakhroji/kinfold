// install and uninstall first build a list of actions, then either print it
// (--dry-run) or print and apply it in order. One list for both is what makes
// a dry run honest: the plan shown is the plan that would run. Descriptions
// carry paths, counts, hosts and argv only; a stored secret prints as
// <hidden>, and a file's content never prints at all.

import { randomBytes } from 'node:crypto'
import { chmodSync, closeSync, fsyncSync, linkSync, mkdirSync, openSync, rmSync, writeSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { fsyncDirectory } from '../../system/fs/atomic'
import { HMAC_LEGACY_REF } from '../secrets/hmac-keys'
import { type KeyStoreRecord, keyStoreRecordContent, readKeyStoreRecord, recordUnreadableMessage } from '../secrets/key-store-record'
import { KEY_STORE_MODULES } from '../secrets/stores/select'
import type { EmbeddedAssets } from '../../system/runtime/embedded'
import type { ObserverSettingsInput } from '../store/observer-settings-store'
import type { DisplayChange } from '../store/display-settings'
import { START_WAIT_MS, putDisplaySettings, putEmbeddingSettings, putObserverSettings, waitForHealth, waitForStart } from '../../controllers/install/daemon-client'
import type { EmbeddingSettings } from '../vectors/embedding-settings'
import { createDbKey, createPlainStore, describeCreateDbKey, describeCreatePlainStore } from '../../controllers/install/db-encryption'
import { type InstallEnv, installPaths, noticeOf } from './env'
import { NOT_FOUND_EXIT } from '../../controllers/install/system'
import { requireKeyStore } from '../../controllers/install/key-store-choice'
import { type TextEncoding, encodeText, readTextOrNull, writeBackup, writeFileAtomic } from './files'
import { backupRemovalSummary, removeHmacBackup, removeRedundantBackup, restoreLegacyKey } from '../../controllers/install/hmac-cleanup'
import { type ModeChange, applyModeChange, describeModeChange } from '../../controllers/install/permissions'
import { describeEmbeddedSqlite3mcInstall, describeSqlite3mcInstall, installEmbeddedSqlite3mc, installSqlite3mc } from '../../controllers/install/sqlite3mc-install'
import { describeEmbeddedVec0Install, installEmbeddedVec0, installVec0 } from '../../controllers/install/vec0-install'
import { CLAUDE_MCP_REMOVE_ARGV, claudeAddArgv, rollbackSafe } from './mcp-wiring'
import { installProgram } from '../../controllers/install/self-install'
import { leftBehindLine, programFilesOf } from '../../controllers/install/program-files'
import { checkDaemonDown, copyKeychainEntry, describeCopyKeychainEntry, describeMoveDataDir, describeRemoveLegacyEntry, moveDataDir, removeLegacyEntry, stopLegacyAgent } from './rename-migration'
import { legacyBootoutArgv } from '../../controllers/install/launch-agent'
import type { Vec0Asset } from '../vectors/vec0-release'
import type { ServiceStep } from '../../controllers/install/service/control'
import { type InstallRecord, writeInstallRecord } from './setup/record'
import { linkCommand, unlinkCommand } from '../../controllers/install/path-setup'
import { type UserPathChange, changeWindowsUserPath } from '../../controllers/install/path-windows'

export const HEALTH_WAIT_MS = 15_000
/** How long launchctl, a host's own CLI or any other command a plan step runs may take. */
export const COMMAND_TIMEOUT_MS = 15_000
export const TAKEOVER_WAIT_MS = 300_000

export type Action =
  | { kind: 'mkdir'; path: string; mode: number }
  | { kind: 'chmod'; dataDir: string; change: ModeChange }
  | { kind: 'touch'; path: string; mode: number }
  | { kind: 'backup'; from: string; to: string }
  /**
   * `before`, when given, is the file's text as the plan read it (null: there was no file), for a file the user or an
   * agent also edits. The write is refused if the file no longer reads that way: `content` was merged from that text,
   * so writing it would drop whatever was saved in between.
   */
  | { kind: 'write'; path: string; content: string; mode: number; summary: string; encoding?: TextEncoding; before?: string | null }
  /** recursive: a directory and everything in it (hmac.d/ on --remove-hmac-keys). */
  /** install.json, merged with what is on disk at the moment of the write (writeInstallRecord). */
  | { kind: 'install-record'; path: string; dataDir: string; record: InstallRecord; summary: string }
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
  /** The display switches named by a flag (--show-recall, --holdout and their opposites), sent to the running daemon. */
  | { kind: 'display-put'; change: DisplayChange }
  | { kind: 'embedding-put'; settings: EmbeddingSettings }
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
  /** ~/.local/bin/kinfold as a link to the installed program; never over a file that is not that link. */
  | { kind: 'link-command'; path: string; target: string }
  /** That link removed, only while it still points at `target`. */
  | { kind: 'unlink-command'; path: string; target: string }
  /** <dataDir>\bin added to or taken off the user PATH in HKCU, and open programs told. */
  | { kind: 'windows-user-path'; change: UserPathChange; dir: string }

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
    case 'write':
    case 'install-record': return `write ${action.path}: ${action.summary}`
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
    case 'display-put': {
      const parts = [...(action.change.showRecall !== undefined ? [`showRecall=${action.change.showRecall}`] : []), ...(action.change.holdout !== undefined ? [`holdout=${action.change.holdout}`] : [])]
      return `PUT /data/display ${parts.join(' ')}`
    }
    case 'embedding-put': {
      const { provider, llmModel, llmUrl } = action.settings
      return `PUT /embedding/settings provider=${provider}${provider === 'local-llm' ? ` model=${llmModel ?? ''} url=${llmUrl ?? ''}` : ''}`
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
    case 'link-command': return `link ${action.path} -> ${action.target}`
    case 'unlink-command': return `remove ${action.path}: the kinfold command link`
    case 'windows-user-path': return `${action.change === 'add' ? `add ${action.dir} to` : `remove ${action.dir} from`} the user PATH (HKCU\\Environment) and tell open programs`
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
    exitCode = (await env.run({ argv, timeoutMs: COMMAND_TIMEOUT_MS })).exitCode
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
  const { exitCode } = await env.run({ argv: action.argv, timeoutMs: COMMAND_TIMEOUT_MS })
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
      const result = await env.run({ argv, timeoutMs: COMMAND_TIMEOUT_MS })
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
const loadServiceControl = (): Promise<typeof import('../../controllers/install/service/control')> => import('../../controllers/install/service/control')

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
  for (const left of programFilesOf(env).removeBinDir(path)) noticeOf(env)(leftBehindLine(left))
}

function touch(path: string, mode: number): void {
  closeSync(openSync(path, 'a', mode))
  chmodSync(path, mode)
}

/** What each run has written, by path: two steps of one plan may write the same file, and the second then finds the first one's text, not the plan-time one. */
const written = new WeakMap<InstallEnv, Map<string, string>>()

function writtenBy(env: InstallEnv): Map<string, string> {
  const known = written.get(env)
  if (known !== undefined) return known
  const fresh = new Map<string, string>()
  written.set(env, fresh)
  return fresh
}

/** Raised when a config file was saved by someone else between the plan and the write. Nothing was written to it. */
export class ChangedSincePlannedError extends Error {
  constructor(readonly path: string) {
    super(`${path} changed while this was running, so it was left as it is; run the command again`)
    this.name = 'ChangedSincePlannedError'
  }
}

function refuseIfChanged(env: InstallEnv, action: Extract<Action, { kind: 'write' }>): void {
  if (action.before === undefined) return
  // Read the way the planners read it: a startup file or a TOML config saved as UTF-16 decodes to the same text both times.
  const now = readTextOrNull(action.path)
  if (now === action.before || (now !== null && now === writtenBy(env).get(action.path))) return
  throw new ChangedSincePlannedError(action.path)
}

export async function applyAction(env: InstallEnv, action: Action): Promise<StepNote | void> {
  switch (action.kind) {
    case 'mkdir': return void (mkdirSync(action.path, { recursive: true, mode: action.mode }), chmodSync(action.path, action.mode))
    case 'chmod': return applyModeChange(action.dataDir, action.change)
    case 'touch': return touch(action.path, action.mode)
    case 'backup': return writeBackup(action.from, action.to)
    case 'write':
      refuseIfChanged(env, action)
      writeFileAtomic(action.path, action.encoding === undefined ? action.content : encodeText(action.content, action.encoding), action.mode)
      return void writtenBy(env).set(action.path, action.content)
    case 'install-record': return writeInstallRecord(action.dataDir, action.record)
    case 'remove': return rmSync(action.path, { force: true, recursive: action.recursive === true })
    case 'remove-program-dir': return removeProgramDir(env, action.path)
    case 'service': return runServiceStep(env, action.step)
    case 'command': return runCommand(env, action)
    case 'claude-mcp-replace': return replaceClaudeMcp(env, action.previous, action.next)
    case 'wait-takeover':
      // The only place the command appears under --takeover, so it goes above the bar.
      noticeOf(env)(`waiting for you to stop the running daemon: ${stopCommand(action.pid, action.port)}`)
      return waitFor(env, false, TAKEOVER_WAIT_MS, `the daemon on port ${action.port} is still running; nothing after this step ran`)
    case 'wait-health': return waitForDaemonStart(env)
    case 'settings-put': return putObserverSettings(env, action.input)
    case 'display-put': return putDisplaySettings(env, action.change)
    case 'embedding-put': return putEmbeddingSettings(env, action.settings)
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
    case 'record-key-store': return createKeyStoreRecord(env, action.path, action.record)
    case 'stop-legacy-agent': return stopLegacyAgent(env)
    case 'migration-daemon-down': return checkDaemonDown(env, action.port, action.waitMs)
    case 'copy-keychain-entry': return copyKeychainEntry(env, action.ref)
    case 'move-data-dir': return moveDataDir(env, action.from, action.to)
    case 'remove-legacy-keychain-entry': return removeLegacyEntry(env, action.ref)
    case 'link-command': return linkCommand(action.path, action.target)
    case 'unlink-command': return unlinkCommand(action.path, action.target)
    case 'windows-user-path': return changeWindowsUserPath(env, action.change, action.dir)
  }
}

function sameStore(a: KeyStoreRecord, b: KeyStoreRecord): boolean {
  return a.store === b.store && a.location === b.location
}

/**
 * Create-only: two installs started from different envs can choose different
 * stores or key folders, and each would then make its own key. The record goes
 * in through a hard link, which fails with EEXIST when another install got
 * there first, so the loser stops here, before any secret step, and a re-run
 * follows the winner's record.
 */
function createKeyStoreRecord(env: InstallEnv, path: string, record: KeyStoreRecord): StepNote | undefined {
  const temp = join(dirname(path), `.${basename(path)}.kinfold-new-${process.pid}-${randomBytes(6).toString('hex')}`)
  let linked = true
  try {
    const fd = openSync(temp, 'wx', 0o600)
    try {
      writeSync(fd, keyStoreRecordContent(record))
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    chmodSync(temp, 0o600)
    try {
      linkSync(temp, path)
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      linked = false
    }
  } finally {
    rmSync(temp, { force: true })
  }
  if (linked) {
    // The folder is flushed too: a record lost in a crash would leave the choice to the missing-record rule.
    fsyncDirectory(dirname(path), { fsyncDir: env.fsyncDir, platform: env.platform })
    return undefined
  }
  const read = readKeyStoreRecord(dirname(path))
  if (read.state === 'unreadable') throw new Error(recordUnreadableMessage(path))
  if (read.state === 'missing') throw new Error(`${path} appeared and went away while this install wrote it; nothing else was changed; run kinfold install again`)
  if (!sameStore(read.record, record)) {
    throw new Error(`another install already chose ${KEY_STORE_MODULES[read.record.store].label}; run kinfold install again. Nothing else was changed and no key was made`)
  }
  return { kept: `another install recorded the ${KEY_STORE_MODULES[read.record.store].label} first; kept its record` }
}

/** What a plan run tells its listeners: the list as a whole, then each action as it starts and as it ends. */
export type PlanEvent =
  | { type: 'begin'; total: number; dryRun: boolean }
  /** `label` is the short form for a progress bar; `line` is the numbered line with paths. */
  | { type: 'start'; index: number; total: number; label: string; line: string }
  /** `planned`: a dry run, which applies nothing. `kept`: the step ran and left something in place, and says why. */
  | { type: 'end'; index: number; line: string; outcome: 'done' | 'kept' | 'failed' | 'planned'; kept?: string; error?: string }

export type PlanListener = (event: PlanEvent) => void

export interface RunPlanOptions {
  /** Who hears the run; default the printed lines on env.out. A bar, the verbose list and the install log are each one more listener. */
  listeners?: readonly PlanListener[]
  /** A bar label per action, by index, where the plan knows more than the action does (which agent a write belongs to). */
  labels?: readonly string[]
}

/** The numbered list, line for line as install and uninstall have always printed it. */
export function linesListener(out: (line: string) => void): PlanListener {
  return (event) => {
    if (event.type === 'begin') {
      if (event.total === 0) out(event.dryRun ? 'plan: nothing to change' : 'nothing to change')
      else out(event.dryRun ? `plan (dry run, nothing is changed): ${event.total} actions` : `applying ${event.total} actions`)
      return
    }
    if (event.type !== 'end') return
    if (event.outcome === 'planned') {
      out(event.line)
      return
    }
    out(`${event.line}  [${event.outcome}]`)
    if (event.kept !== undefined) out(`     ${event.kept}`)
  }
}

/** A few words for the progress bar: what is happening, with no path, count or argv. */
export function shortLabel(action: Action): string {
  switch (action.kind) {
    case 'mkdir': return `creating the ${basename(action.path)} folder`
    case 'chmod': return 'setting file permissions'
    case 'touch': return `creating ${basename(action.path)}`
    case 'backup': return `backing up ${basename(action.from)}`
    case 'write': return `writing ${basename(action.path)}`
    case 'install-record': return 'saving the install record'
    case 'remove': return `removing ${basename(action.path)}`
    case 'remove-program-dir': return 'removing the kinfold program'
    case 'service': return action.step === 'start' ? 'starting the daemon' : 'stopping the daemon'
    case 'command': return action.summary
    case 'claude-mcp-replace': return 'updating the Claude Code MCP entry'
    case 'wait-takeover': return 'waiting for the running daemon to stop'
    case 'wait-health': return 'waiting for the daemon to answer'
    case 'settings-put': return `saving the observer for ${action.input.host}`
    case 'display-put': return 'saving the recall line and impact test settings'
    case 'embedding-put': return 'saving the embedding choice'
    case 'secret-set': return 'storing a key'
    case 'secret-delete': return 'removing a key'
    case 'remove-hmac-backup':
    case 'restore-hmac-legacy':
    case 'hmac-daemon-down':
    case 'remove-redundant-hmac-backup': return 'tidying the HMAC keys'
    case 'install-vec0':
    case 'install-vec0-embedded': return 'installing sqlite-vec'
    case 'install-sqlite3mc':
    case 'install-sqlite3mc-embedded': return 'installing the SQLite library'
    case 'install-program': return 'installing the kinfold program'
    case 'create-db-key': return 'creating the database key'
    case 'create-plain-store': return 'creating the store'
    case 'record-key-store': return 'recording the key store'
    case 'stop-legacy-agent':
    case 'migration-daemon-down':
    case 'copy-keychain-entry':
    case 'move-data-dir':
    case 'remove-legacy-keychain-entry': return 'moving to the Kinfold names'
    case 'link-command': return 'linking the kinfold command'
    case 'unlink-command': return 'removing the kinfold command'
    case 'windows-user-path': return action.change === 'add' ? 'adding kinfold to PATH' : 'taking kinfold off PATH'
  }
}

/**
 * Runs the plan, or only lists it when dry, and stops at the first failure, naming the step. What is
 * printed is up to the listeners; with none given, the numbered lines go to env.out as they always did.
 * failureNote adds what the failure leaves behind (the rename migration says which daemon still runs).
 */
export async function runPlan(env: InstallEnv, actions: readonly Action[], dryRun: boolean, failureNote?: (index: number) => string | null, options: RunPlanOptions = {}): Promise<void> {
  const listeners = options.listeners ?? [linesListener(env.out)]
  const tell = (event: PlanEvent): void => {
    for (const listener of listeners) listener(event)
  }
  const total = actions.length
  tell({ type: 'begin', total, dryRun })
  for (const [index, action] of actions.entries()) {
    const line = `  ${index + 1}. ${describeAction(action)}`
    tell({ type: 'start', index, total, label: options.labels?.[index] ?? shortLabel(action), line })
    if (dryRun) {
      tell({ type: 'end', index, line, outcome: 'planned' })
      continue
    }
    try {
      const note = await applyAction(env, action)
      const kept = note ? note.kept : null
      tell(kept === null ? { type: 'end', index, line, outcome: 'done' } : { type: 'end', index, line, outcome: 'kept', kept })
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error)
      tell({ type: 'end', index, line, outcome: 'failed', error: message })
      const note = failureNote?.(index) ?? null
      throw new Error(`step ${index + 1} failed: ${message}${note === null ? '' : `; ${note}`}`)
    }
  }
}
