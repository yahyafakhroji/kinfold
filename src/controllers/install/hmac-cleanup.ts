// Cleanup for the HMAC keys, in two places:
//   install:   the plain-text backup of hmac.key that the migration leaves
//              undoes epoch 0's protection while it exists, so install removes
//              it, this run's and any left by earlier runs. It removes a backup
//              only once (1) Keychain hmac-legacy reads back equal to it,
//              compared in this process and never printed, and (2) the daemon
//              answers /health in master mode after the reload. Otherwise the
//              backup stays and the reason and an rm command print.
//              The read-back goes through the key store that created the
//              entry; on macOS that is the same binary the daemon reads
//              through, so it is on the entry's ACL and there is no new prompt.
//   uninstall: --remove-hmac-keys writes hmac.key back from hmac-legacy (so a
//              later install still verifies epoch-0 refs), then deletes both
//              Keychain entries and hmac.d/. It first waits for /health to
//              stop answering and refuses while a daemon (a hand-started one,
//              say) still answers, since that daemon would write a new
//              sub-key afterwards. A kept install backup that equals the
//              restored hmac.key goes too; one that differs stays. A failed
//              check or restore stops the plan before anything is deleted.
// Messages carry paths, refs and modes only; key bytes never print.

import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { HMAC_LEGACY_REF, HMAC_MASTER_REF, isHexKey } from '../secrets/hmac-keys'
import type { KeyStore } from '../secrets/key-store'
import { DATA_FILE_MODE, HMAC_KEY_FILE } from '../store/data-dir'
import { listSubKeyEpochs, subKeyDir } from '../store/hmac-key'
import { checkHealth, readDaemonInfo } from './daemon-client'
import { type InstallEnv, errorMessage } from './env'
import { existingBackups, writeFileAtomic } from './files'
import { keyStoreOf, noStoreWord, secretDeleteAction } from './key-store-choice'
import type { Action, StepNote } from './plan'

export function backupRemovalSummary(storeLabel: string): string {
  return `plain-text backup of epoch 0; the value is in ${storeLabel} entry ${HMAC_LEGACY_REF}`
}
export const REMOVE_HMAC_CONSEQUENCE = 'stored refs can no longer be checked, and a later install starts a new master'

function legacyFromKeychain(env: InstallEnv): string | null {
  return keyStoreOf(env)?.get(HMAC_LEGACY_REF) ?? null
}

/** Reached only with a store in hand; the fallback keeps a message readable if the store went away. */
function storeLabelOf(env: InstallEnv): string {
  return keyStoreOf(env)?.label ?? noStoreWord(env)
}

/** One guarded removal per backup: those already on disk plus the one this run writes. */
export function hmacBackupRemovals(env: InstallEnv, plannedBackup: string | null): Action[] {
  const store = keyStoreOf(env)
  if (store === null) return []
  const existing = existingBackups(join(env.dataDir, HMAC_KEY_FILE))
  const paths = [...new Set([...existing, ...(plannedBackup !== null ? [plannedBackup] : [])])]
  return paths.map((path): Action => ({ kind: 'remove-hmac-backup', path, storeLabel: store.label }))
}

function backupMismatch(env: InstallEnv, path: string): string | null {
  const label = storeLabelOf(env)
  let stored: string | null
  try {
    stored = legacyFromKeychain(env)
  } catch (error: unknown) {
    return `the ${label} read-back of ${HMAC_LEGACY_REF} failed (${errorMessage(error)})`
  }
  if (stored === null) return `${label} entry ${HMAC_LEGACY_REF} is missing`
  let backup: string
  try {
    backup = readFileSync(path, 'utf8').trim()
  } catch (error: unknown) {
    return `it could not be read (${error instanceof Error ? error.name : 'error'})`
  }
  return backup === stored ? null : `it differs from ${label} entry ${HMAC_LEGACY_REF}`
}

/** Null when the backup may go; else why it stays. */
export async function backupKeepReason(env: InstallEnv, path: string): Promise<string | null> {
  const mismatch = backupMismatch(env, path)
  if (mismatch !== null) return mismatch
  const health = await checkHealth(env, readDaemonInfo(env.dataDir).port)
  if (!health.up) return `the daemon is not healthy (${health.reason})`
  if (health.hmacMode !== 'master') return `the daemon runs in ${health.hmacMode ?? 'an unreported'} hmac mode, not master`
  return null
}

export async function removeHmacBackup(env: InstallEnv, path: string): Promise<StepNote | undefined> {
  const reason = await backupKeepReason(env, path)
  if (reason !== null) return { kept: `kept ${path}: ${reason}. Once that is fixed, delete it with: rm ${path}` }
  rmSync(path, { force: true })
  return undefined
}

/** Uninstall: a kept install backup goes once hmac.key holds the same value; compared in process, never printed. */
export function removeRedundantBackup(path: string, legacyPath: string): StepNote | undefined {
  let same: boolean
  try {
    same = readFileSync(path, 'utf8').trim() === readFileSync(legacyPath, 'utf8').trim()
  } catch (error: unknown) {
    return { kept: `kept ${path}: it or ${legacyPath} could not be read (${error instanceof Error ? error.name : 'error'})` }
  }
  if (!same) return { kept: `kept ${path}: it differs from ${legacyPath}, so it may be the only copy of a key` }
  rmSync(path, { force: true })
  return undefined
}

/** Epoch 0's key back on disk as the pre-rotation file (hex, no newline, 0600). Throws, so no later step runs. */
export function restoreLegacyKey(env: InstallEnv, path: string): void {
  const value = legacyFromKeychain(env)
  if (value === null || !isHexKey(value)) throw new Error(`${storeLabelOf(env)} entry ${HMAC_LEGACY_REF} is missing or not a key; nothing was deleted`)
  writeFileAtomic(path, value, DATA_FILE_MODE)
}

export interface HmacRemoval {
  actions: Action[]
  notes: string[]
}

function removalActions(env: InstallEnv, store: KeyStore, hasMaster: boolean, hasLegacy: boolean, restore: boolean): Action[] {
  const legacyPath = join(env.dataDir, HMAC_KEY_FILE)
  const dir = subKeyDir(env.dataDir)
  const files = listSubKeyEpochs(env.dataDir).length
  return [
    ...(restore ? [{ kind: 'restore-hmac-legacy', path: legacyPath, storeLabel: store.label } as const] : []),
    ...existingBackups(legacyPath).map((path) => ({ kind: 'remove-redundant-hmac-backup', path, legacyPath }) as const),
    ...(hasMaster ? [secretDeleteAction(store, HMAC_MASTER_REF, `the HMAC master; ${REMOVE_HMAC_CONSEQUENCE}`)] : []),
    ...(hasLegacy ? [secretDeleteAction(store, HMAC_LEGACY_REF, `epoch 0's key; its value stays in ${legacyPath}`)] : []),
    ...(existsSync(dir)
      ? [{ kind: 'remove', path: dir, recursive: true, summary: `the marker sub-keys (${files} file${files === 1 ? '' : 's'}); ${REMOVE_HMAC_CONSEQUENCE}` } as const]
      : []),
  ]
}

/** `kinfold uninstall --remove-hmac-keys`: restore hmac.key, delete both entries, remove hmac.d/. */
export function hmacRemoval(env: InstallEnv, dryRun: boolean): HmacRemoval {
  const store = keyStoreOf(env)
  if (store === null) return { actions: [], notes: [`hmac keys: no ${noStoreWord(env)} on ${env.platform}; nothing to remove`] }
  const legacyPath = join(env.dataDir, HMAC_KEY_FILE)
  const hasLegacy = store.exists(HMAC_LEGACY_REF)
  const restore = hasLegacy && !existsSync(legacyPath)
  const removals = removalActions(env, store, store.exists(HMAC_MASTER_REF), hasLegacy, restore)
  if (removals.length === 0) return { actions: removals, notes: [`hmac keys: no ${store.label} entries or sub-keys to remove`] }
  const { pid, port } = readDaemonInfo(env.dataDir)
  const actions: Action[] = [{ kind: 'hmac-daemon-down', pid, port }, ...removals]
  const verb = dryRun ? 'a real run writes' : 'wrote'
  const notes = restore
    ? [`${verb} ${legacyPath} from ${store.label} entry ${HMAC_LEGACY_REF}, so a later install still verifies refs stored before the migration; if you do not want that, delete it yourself: rm ${legacyPath}`]
    : []
  return { actions, notes }
}
