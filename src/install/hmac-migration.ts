// The HMAC key migration, run by `kinfold install` only: the user runs it,
// so it is the one place a Keychain entry gets created. It
//   1. copies hmac.key into the Keychain as hmac-legacy (epoch 0, so every
//      ref stored so far still verifies);
//   2. creates the master as new random bytes (hmac-master). It is not
//      derived from hmac.key: that file sat in plain text next to memory.db
//      (and in any backup of the data dir), so a master derived from it
//      would be exposed wherever the file ever was;
//   3. writes the current epoch's sub-key to hmac.d/, so capture has a key
//      before the daemon first rotates;
//   4. backs hmac.key up (0600, like every file the installer replaces) and
//      removes it; then the daemon restarts so it reads the master;
//   5. at the very end, removes that backup and any older one, each
//      only after a Keychain read-back and a master-mode /health
//      (hmac-cleanup.ts); a backup that fails a check stays, with the reason.
// A dry run shows the same steps; values print as <hidden> and file
// contents never print. status and uninstall read Keychain metadata only.

import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { KEYCHAIN_SERVICE } from '../secrets/credentials'
import { HMAC_LEGACY_REF, HMAC_MASTER_REF, epochAt, isHexKey, markerSubKey } from '../secrets/hmac-keys'
import { credentialWriterFor } from '../secrets/keychain-writer'
import { DATA_DIR_MODE, DATA_FILE_MODE, HMAC_KEY_FILE } from '../store/data-dir'
import { listSubKeyEpochs, subKeyDir, subKeyPath } from '../store/hmac-key'
import { type InstallEnv, errorMessage } from './env'
import { BACKUP_INFIX, backupStamp, existingBackups } from './files'
import { hmacBackupRemovals } from './hmac-cleanup'
import type { Action } from './plan'

export interface HmacMigration {
  actions: Action[]
  /** The daemon must restart to read a master it has not seen. */
  restartDaemon: boolean
  /** Guarded backup removals; they go last, after the daemon is healthy again. */
  cleanup: Action[]
}

function legacyKeyValue(path: string): string {
  const value = readFileSync(path, 'utf8').trim()
  if (!isHexKey(value)) throw new Error(`${path} does not hold a 32-byte hex key; leaving it untouched`)
  return value
}

function newMasterActions(env: InstallEnv): Action[] {
  const master = randomBytes(32).toString('hex')
  const epoch = epochAt(env.now())
  const dir = subKeyDir(env.dataDir)
  if (listSubKeyEpochs(env.dataDir).length > 0) env.out('hmac keys: hmac.d holds sub-keys but the Keychain has no master; refs from those epochs cannot be rebuilt after this')
  return [
    { kind: 'keychain-put', ref: HMAC_MASTER_REF, value: master },
    ...(existsSync(dir) ? [] : [{ kind: 'mkdir', path: dir, mode: DATA_DIR_MODE } as const]),
    { kind: 'write', path: subKeyPath(env.dataDir, epoch), content: `${markerSubKey(master, epoch)}\n`, mode: DATA_FILE_MODE, summary: `marker sub-key for epoch ${epoch}, derived from the new master` },
  ]
}

function legacyActions(path: string, backup: string): Action[] {
  return [
    { kind: 'keychain-put', ref: HMAC_LEGACY_REF, value: legacyKeyValue(path) },
    { kind: 'backup', from: path, to: backup },
    { kind: 'remove', path, summary: `the plain-text marker key; its value is now keychain entry ${HMAC_LEGACY_REF} (epoch 0)` },
  ]
}

/** Keychain puts first, so the file is removed only after its value is stored (put verifies the entry exists). */
export function hmacMigrationActions(env: InstallEnv): HmacMigration {
  const writer = credentialWriterFor(env.platform, env.security)
  const legacyPath = join(env.dataDir, HMAC_KEY_FILE)
  if (writer === null) {
    env.out(`hmac keys: no keychain on ${env.platform}; the marker key stays in ${legacyPath}`)
    return { actions: [], restartDaemon: false, cleanup: [] }
  }
  const hasMaster = writer.exists(HMAC_MASTER_REF)
  const backup = existsSync(legacyPath) ? `${legacyPath}${BACKUP_INFIX}${backupStamp(env.now())}` : null
  const legacy = backup !== null ? legacyActions(legacyPath, backup) : []
  const master = hasMaster ? [] : newMasterActions(env)
  if (hasMaster && legacy.length === 0) env.out('hmac keys: master in keychain, no hmac.key; nothing to migrate')
  // The legacy put first, then the master and its sub-key, then the backup and the removal.
  const actions = [...legacy.slice(0, 1), ...master, ...legacy.slice(1)]
  return { actions, restartDaemon: master.length > 0, cleanup: hmacBackupRemovals(env, backup) }
}

function presence(env: InstallEnv, ref: string): string {
  const writer = credentialWriterFor(env.platform, env.security)
  if (writer === null) return 'none'
  try {
    return writer.exists(ref) ? 'present' : 'missing'
  } catch (error: unknown) {
    return `unknown (${errorMessage(error)})`
  }
}

/** `kinfold status`: Keychain metadata, sub-key epochs, and any plain-text key or backup still on disk. */
export function hmacStatusLines(env: InstallEnv): string[] {
  const legacyPath = join(env.dataDir, HMAC_KEY_FILE)
  const epochs = listSubKeyEpochs(env.dataDir)
  const master = presence(env, HMAC_MASTER_REF)
  const mode = master === 'present' ? 'keychain master' : existsSync(legacyPath) ? 'hmac.key file (run kinfold install to move it to the keychain)' : 'none yet'
  return [
    `hmac keys: ${mode}; keychain ${HMAC_MASTER_REF} ${master}, ${HMAC_LEGACY_REF} ${presence(env, HMAC_LEGACY_REF)}`,
    `  sub-keys in ${subKeyDir(env.dataDir)}: ${epochs.length > 0 ? `epochs ${epochs.join(', ')}` : 'none'}`,
    ...(master === 'present' && existsSync(legacyPath) ? [`  warning: ${legacyPath} still exists; run kinfold install to finish the migration`] : []),
    ...existingBackups(legacyPath).map((path) => `  warning: plain-text key backup ${path}; delete it once you no longer need to roll back (rm ${path})`),
  ]
}

/** `kinfold uninstall` keeps the HMAC entries unless --remove-hmac-keys: without them stored refs can never be checked again. */
export function hmacKeptNotes(env: InstallEnv): string[] {
  const writer = credentialWriterFor(env.platform, env.security)
  if (writer === null) return []
  return [HMAC_MASTER_REF, HMAC_LEGACY_REF]
    .filter((ref) => writer.exists(ref))
    .map((ref) => `kept keychain entry ${ref} (marker refs in the data dir need it); remove it with: security delete-generic-password -s ${KEYCHAIN_SERVICE} -a ${ref}  (or rerun with --remove-hmac-keys)`)
}
