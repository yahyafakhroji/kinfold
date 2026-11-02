// Where everything lives on disk, and the owner-only rules for it. The data
// directory holds the database, the spool and the local secrets, so it is 0700
// and every file in it 0600, whatever the caller's umask says.

import { chmodSync, closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, statSync, writeSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { envName, readEnv } from '../env-names'
import { DATA_DIR_NAME, LEGACY_DATA_DIR_NAME } from '../names'

export const DATA_DIR_MODE = 0o700
export const DATA_FILE_MODE = 0o600
export const DEFAULT_DATA_DIR_NAME = DATA_DIR_NAME

export const DB_FILE = 'memory.db'
export const SPOOL_DIR = 'spool'
export const TOKEN_FILE = 'daemon.token'
export const DAEMON_INFO_FILE = 'daemon.json'
/** The pre-rotation marker key; after `kinfold install` migrates it, it lives in the Keychain and this file is gone. */
export const HMAC_KEY_FILE = 'hmac.key'
/** Per-epoch marker sub-keys the daemon derives from the Keychain master: hmac.d/<YYYYMM>.key. */
export const HMAC_SUBKEY_DIR = 'hmac.d'

const SECRET_BYTES = 32
const SECRET_PATTERN = /^[0-9a-f]{64}$/

type Env = Readonly<Record<string, string | undefined>>

/**
 * The data dir `kinfold install` and the rename migration target: the
 * configured one, else ~/.kinfold. It never falls back to the old name, so
 * the migration always moves the old dir here.
 */
export function resolveInstallDataDir(env: Env = process.env, home: string = homedir()): string {
  const configured = readEnv(env, 'DATA_DIR')
  if (configured === undefined || configured === '') return join(home, DEFAULT_DATA_DIR_NAME)
  if (!isAbsolute(configured)) throw new Error(`${envName('DATA_DIR')} must be an absolute path`)
  return configured
}

function isRealDir(path: string): boolean {
  try {
    const stat = lstatSync(path)
    return stat.isDirectory() && !stat.isSymbolicLink()
  } catch {
    return false
  }
}

function pathExists(path: string): boolean {
  try {
    lstatSync(path)
    return true
  } catch {
    return false
  }
}

/**
 * The data dir for every other process: the daemon, hooks, MCP, dashboard and
 * status. Until the migration runs, ~/.kinfold does not exist and the store is
 * still the real directory ~/.shared-agent-memory, so that one is used; new
 * code then never creates a second store (with its own hmac.key) beside it.
 * After the migration the old path is a symlink and ~/.kinfold is used.
 */
export function resolveDataDir(env: Env = process.env, home: string = homedir()): string {
  const target = resolveInstallDataDir(env, home)
  const configured = readEnv(env, 'DATA_DIR')
  if (configured !== undefined && configured !== '') return target
  const legacy = join(home, LEGACY_DATA_DIR_NAME)
  return !pathExists(target) && isRealDir(legacy) ? legacy : target
}

export function ensureDataDir(dir: string): string {
  mkdirSync(dir, { recursive: true, mode: DATA_DIR_MODE })
  chmodSync(dir, DATA_DIR_MODE)
  return dir
}

/** Tightens a file that something else created with a looser mode. */
export function enforceFileMode(path: string): void {
  if (existsSync(path) && (statSync(path).mode & 0o777) !== DATA_FILE_MODE) chmodSync(path, DATA_FILE_MODE)
}

/** Creates the file with mode 0600; `exclusive` makes a concurrent creator fail with EEXIST instead of overwriting. */
export function writePrivateFile(path: string, content: string, exclusive: boolean): void {
  const fd = openSync(path, exclusive ? 'wx' : 'w', DATA_FILE_MODE)
  try {
    writeSync(fd, content)
  } finally {
    closeSync(fd)
  }
  chmodSync(path, DATA_FILE_MODE)
}

function readSecret(path: string): string {
  const value = readFileSync(path, 'utf8').trim()
  if (!SECRET_PATTERN.test(value)) throw new Error(`${path} does not hold a 32-byte hex secret`)
  enforceFileMode(path)
  return value
}

function isAlreadyExists(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'EEXIST'
}

/**
 * Returns the 32-byte hex secret in `path`, creating it on first use. Two
 * processes racing to create it both end up reading the winner's value.
 */
export function readOrCreateSecret(path: string): string {
  if (existsSync(path)) return readSecret(path)
  try {
    writePrivateFile(path, randomBytes(SECRET_BYTES).toString('hex'), true)
  } catch (error: unknown) {
    if (!isAlreadyExists(error)) throw error
  }
  return readSecret(path)
}
