// Database encryption in `sam install` and `sam status` (P2-E slice E2). On a
// data dir with no memory.db yet, install puts a new random key in the
// Keychain (db-key), so the daemon creates the store encrypted
// (src/sqlite/open.ts). An existing store is never touched here: `sam
// encrypt` converts it (E3). Status reads the file's header and Keychain
// metadata only, never the key, and warns when FileVault is off, since the
// spool, logs and host transcripts sit outside memory.db.

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { DB_KEY_NEXT_REF, DB_KEY_REF, KEYCHAIN_SERVICE } from '../secrets/credentials'
import { credentialWriterFor } from '../secrets/keychain-writer'
import { newDbKey } from '../sqlite/keys'
import { backupPath } from '../sqlite/convert'
import { fileState, maintenancePath } from '../sqlite/open'
import { DB_FILE } from '../store/data-dir'
import { type InstallEnv, errorMessage } from './env'
import type { Action } from './plan'

export const FDESETUP = '/usr/bin/fdesetup'

/** The key for a store the daemon has yet to create; nothing for an existing store or without a Keychain. */
export function dbKeyActions(env: InstallEnv): Action[] {
  const path = join(env.dataDir, DB_FILE)
  const state = fileState(path)
  const writer = credentialWriterFor(env.platform, env.security)
  if (state === 'plain') {
    env.out(`database: ${path} is plaintext; it stays that way until sam encrypt`)
    return []
  }
  if (state === 'encrypted') return []
  if (writer === null) {
    env.out(`database: no key store on ${env.platform} yet; the new store is created plaintext`)
    return []
  }
  if (writer.exists(DB_KEY_REF)) {
    env.out(`database: keychain entry ${DB_KEY_REF} found; the new store is created encrypted with it`)
    return []
  }
  env.out('database: the new store is created encrypted; its key goes in the Keychain')
  return [{ kind: 'create-db-key', path }]
}

export function describeCreateDbKey(path: string): string {
  return `keychain: create ${DB_KEY_REF} (32 random bytes, never shown) for the new store ${path}, unless an entry exists already`
}

/**
 * Run time, not plan time: the store must still be new (downloads ran in
 * between), and the add never replaces an entry, so a key that some store
 * already uses is never lost.
 */
export function createDbKey(env: InstallEnv, path: string): void {
  if (fileState(path) !== 'new') {
    env.out(`database: ${path} appeared while install ran; no key was created`)
    return
  }
  const writer = credentialWriterFor(env.platform, env.security)
  if (writer === null) throw new Error(`no key store on ${env.platform}`)
  if (!writer.create(DB_KEY_REF, newDbKey())) env.out(`database: keychain entry ${DB_KEY_REF} exists already; kept it`)
}

function keyPresence(env: InstallEnv): string {
  const writer = credentialWriterFor(env.platform, env.security)
  if (writer === null) return 'no key store'
  try {
    return writer.exists(DB_KEY_REF) ? `keychain ${DB_KEY_REF} present` : `keychain ${DB_KEY_REF} missing`
  } catch (error: unknown) {
    return `keychain ${DB_KEY_REF} unknown (${errorMessage(error)})`
  }
}

async function diskEncryptionLine(env: InstallEnv): Promise<string | null> {
  if (env.platform !== 'darwin') return null
  const result = await env.run({ argv: [FDESETUP, 'status'], timeoutMs: 5_000 })
  if (result.exitCode !== 0) return `disk encryption: could not check (fdesetup exit ${result.exitCode})`
  if (result.stdout.includes('FileVault is On')) return 'disk encryption: FileVault on'
  if (result.stdout.includes('FileVault is Off')) {
    return 'warning: FileVault is off; the spool, logs and agent transcripts are unencrypted on disk. Turn it on in System Settings > Privacy & Security'
  }
  return 'disk encryption: FileVault state unknown'
}

/** `sam status`: how memory.db is stored, whether its key entry exists (metadata only), and the disk encryption state. */
export async function dbStatusLines(env: InstallEnv): Promise<string[]> {
  const path = join(env.dataDir, DB_FILE)
  const state = fileState(path)
  const keys = keyPresence(env)
  const database = state === 'new'
    ? `database: not created yet (${keys})`
    : state === 'plain'
      ? `database: plaintext; sam encrypt converts it (${keys})`
      : `database: encrypted (${keys})`
  const lines = [database]
  if (state === 'plain' && keys.endsWith('present')) {
    lines.push(`warning: memory.db is plaintext but the Keychain holds ${DB_KEY_REF}; the file was replaced by a plaintext copy, or a conversion failed`)
  }
  if (existsSync(maintenancePath(path))) {
    lines.push(`warning: ${maintenancePath(path)} is there: a sam encrypt, decrypt or rekey is running or was cut short; nothing opens memory.db until it goes. If none is running, run sam key resume`)
  }
  if (existsSync(backupPath(path))) {
    lines.push(`warning: ${backupPath(path)} is left from a conversion that was cut short; it is the original store; run sam key resume`)
  }
  const writer = credentialWriterFor(env.platform, env.security)
  try {
    if (writer?.exists(DB_KEY_NEXT_REF) === true) lines.push(`warning: the Keychain holds ${DB_KEY_NEXT_REF}: a sam rekey was cut short; run sam key resume`)
  } catch {
    // keyPresence already reported a failing lookup.
  }
  if (state === 'encrypted' && keys.endsWith('missing')) {
    lines.push(`warning: memory.db is encrypted and the Keychain has no ${DB_KEY_REF} under ${KEYCHAIN_SERVICE}; restore it with sam key recover`)
  }
  const disk = await diskEncryptionLine(env)
  return disk === null ? lines : [...lines, disk]
}
