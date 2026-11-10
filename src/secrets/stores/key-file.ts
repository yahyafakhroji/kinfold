// Linux secrets kept as one 0600 file per entry in a 0700 folder under the XDG
// config home. A key file never sits inside the memory folder: copying, backing
// up or syncing that folder must not carry the key that opens it.

import { randomBytes } from 'node:crypto'
import {
  type Stats,
  accessSync,
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeSync,
} from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fsyncDirectory, writeFileAtomic } from '../../fs/atomic'
import { CLI_NAME } from '../../names'
import { assertCredentialRef, assertStorableValue } from '../credentials'
import type { KeyStore, KeyStoreDeps, KeyStoreModule, KeyStoreProbe } from '../key-store'

export const KEY_FILE_MODE = 0o600
export const KEY_DIR_MODE = 0o700

/** The store's `notes`; the wizard prints them under the encryption step's "on" choice. */
export const KEY_FILE_NOTES: readonly [string, string] = [
  'Encryption with a key file protects copies, backups and synced folders.',
  'It does not protect against anyone who can log in as you.',
]

const LABEL = 'key file'
const OPEN_TO_OTHERS = 0o077
// Windows has no O_NOFOLLOW; the store is never usable there.
const READ_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)

/** deps.location when set (the folder recorded at install), else the XDG rule. */
export function keyFileDir(deps: Pick<KeyStoreDeps, 'homeDir' | 'envVars' | 'location'>): string {
  if (deps.location !== undefined && deps.location !== '') return deps.location
  const xdg = deps.envVars.XDG_CONFIG_HOME
  // The XDG spec says a relative value is invalid and must be ignored.
  const base = xdg !== undefined && xdg !== '' && isAbsolute(xdg) ? xdg : join(deps.homeDir, '.config')
  return join(base, CLI_NAME)
}

export function keyFilePath(dir: string, account: string): string {
  return join(dir, `${account}.key`)
}

export interface KeyFileOptions {
  /** The memory folder the key folder must stay out of: deps.dataDir. */
  dataDir: string
  /** Test seam: one line per filesystem touch, e.g. "stat db-key", "read db-key". */
  trace?: (event: string) => void
  /** Shown as ~ in `place`; absent, the folder is shown in full. */
  homeDir?: string
}

// Each reason is the text after "key file: ", so the probe and the store say the same thing.
const reasons = {
  notFolder: (dir: string) => `${dir} is not a folder`,
  looseDir: (dir: string, mode: number) => `${dir} is open to other users (mode ${octal(mode)}); run chmod 700 ${dir}`,
  looseFile: (path: string, mode: number) => `${path} is open to other users (mode ${octal(mode)}); run chmod 600 ${path}`,
  notRegular: (path: string) => `${path} is not a regular file`,
  otherUser: (path: string) => `${path} belongs to another user`,
  invalid: (path: string) => `${path} does not hold a valid key`,
  failed: (op: string, path: string, code: string) => `${op} ${path} failed (${code})`,
  inside: (dir: string, dataDir: string) =>
    `the key folder ${dir} is inside the memory folder ${dataDir}; set XDG_CONFIG_HOME to a folder outside it`,
  notWritable: (ancestor: string) => `${ancestor} is not writable`,
}

function octal(mode: number): string {
  return (mode & 0o777).toString(8)
}

class KeyFileError extends Error {
  constructor(reason: string) {
    super(`${LABEL}: ${reason}`)
  }
}

function errnoOf(error: unknown): string | null {
  if (error instanceof KeyFileError) return null
  const code = (error as NodeJS.ErrnoException | null)?.code
  return typeof code === 'string' ? code : null
}

/** The fixed message for a failed call; the error's own text can name a temp file. */
function failure(op: string, path: string, error: unknown): unknown {
  const code = errnoOf(error)
  return code === null ? error : new KeyFileError(reasons.failed(op, path, code))
}

function fsCall<T>(op: string, path: string, call: () => T): T {
  try {
    return call()
  } catch (error: unknown) {
    throw failure(op, path, error)
  }
}

function currentUid(): number {
  return process.getuid?.() ?? -1
}

function isInside(dir: string, dataDir: string): boolean {
  const rel = relative(resolve(dataDir), resolve(dir))
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/** The reason a folder that exists is unsafe, or null when it is fine. */
function unsafeFolderReason(dir: string, stats: Stats): string | null {
  if (!stats.isDirectory()) return reasons.notFolder(dir)
  if (stats.uid !== currentUid()) return reasons.otherUser(dir)
  if ((stats.mode & OPEN_TO_OTHERS) !== 0) return reasons.looseDir(dir, stats.mode)
  return null
}

function lstatOrNull(path: string): Stats | null {
  try {
    return lstatSync(path)
  } catch (error: unknown) {
    if (errnoOf(error) === 'ENOENT') return null
    throw error
  }
}

function tildify(dir: string, homeDir: string | undefined): string {
  if (homeDir === undefined || homeDir === '') return dir
  if (dir === homeDir) return '~'
  return dir.startsWith(homeDir + sep) ? join('~', dir.slice(homeDir.length + 1)) : dir
}

function writeNewFile(path: string, content: string): void {
  const fd = openSync(path, 'wx', KEY_FILE_MODE)
  try {
    writeSync(fd, content)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  chmodSync(path, KEY_FILE_MODE)
}

export function createKeyFileStore(dir: string, options: KeyFileOptions): KeyStore {
  const trace = options.trace ?? (() => {})
  const pathOf = (account: string) => keyFilePath(dir, account)

  /** Checks the folder; false when it does not exist. Never creates it. */
  const folderExists = (op: string): boolean => {
    if (isInside(dir, options.dataDir)) throw new KeyFileError(reasons.inside(dir, options.dataDir))
    trace('stat folder')
    const stats = fsCall(op, dir, () => lstatOrNull(dir))
    if (stats === null) return false
    const unsafe = unsafeFolderReason(dir, stats)
    if (unsafe !== null) throw new KeyFileError(unsafe)
    return true
  }

  /** Makes the leaf at 0700 when missing; parents get the default mode and are never chmodded. */
  const ensureFolder = (op: string): void => {
    if (folderExists(op)) return
    trace('mkdir folder')
    fsCall(op, dir, () => {
      mkdirSync(dirname(dir), { recursive: true })
      try {
        mkdirSync(dir, { mode: KEY_DIR_MODE })
        chmodSync(dir, KEY_DIR_MODE)
      } catch (error: unknown) {
        if (errnoOf(error) !== 'EEXIST') throw error
      }
    })
    // Another process may have made it first; check what is there either way.
    folderExists(op)
  }

  const syncFolder = (op: string): void => {
    trace('fsync folder')
    fsCall(op, dir, () => fsyncDirectory(dir))
  }

  const openForRead = (account: string): number | null => {
    const path = pathOf(account)
    trace(`open ${account}`)
    try {
      return openSync(path, READ_FLAGS)
    } catch (error: unknown) {
      const code = errnoOf(error)
      if (code === 'ENOENT') return null
      // O_NOFOLLOW on a symlink fails with ELOOP.
      if (code === 'ELOOP') throw new KeyFileError(reasons.notRegular(path))
      throw failure('read', path, error)
    }
  }

  const readOpen = (account: string, fd: number): string => {
    const path = pathOf(account)
    trace(`stat ${account}`)
    const stats = fsCall('read', path, () => fstatSync(fd))
    if (!stats.isFile()) throw new KeyFileError(reasons.notRegular(path))
    if (stats.uid !== currentUid()) throw new KeyFileError(reasons.otherUser(path))
    if ((stats.mode & OPEN_TO_OTHERS) !== 0) throw new KeyFileError(reasons.looseFile(path, stats.mode))
    trace(`read ${account}`)
    const text = fsCall('read', path, () => readFileSync(fd, 'utf8'))
    const value = text.endsWith('\n') ? text.slice(0, -1) : text
    try {
      assertStorableValue(value)
    } catch {
      throw new KeyFileError(reasons.invalid(path))
    }
    return value
  }

  const get = (account: string): string | null => {
    assertCredentialRef(account)
    if (!folderExists('read')) return null
    const fd = openForRead(account)
    if (fd === null) return null
    try {
      return readOpen(account, fd)
    } finally {
      closeSync(fd)
    }
  }

  const exists = (account: string): boolean => {
    assertCredentialRef(account)
    if (!folderExists('check')) return false
    const path = pathOf(account)
    trace(`stat ${account}`)
    return fsCall('check', path, () => lstatOrNull(path)) !== null
  }

  const set = (account: string, value: string): void => {
    assertCredentialRef(account)
    assertStorableValue(value)
    ensureFolder('write')
    const path = pathOf(account)
    trace(`write ${account}`)
    fsCall('write', path, () => writeFileAtomic(path, `${value}\n`, KEY_FILE_MODE, { syncDir: true }))
  }

  // A hard link fails with EEXIST when the name is taken, so "never replaces"
  // holds across processes without a lock.
  const create = (account: string, value: string): boolean => {
    assertCredentialRef(account)
    assertStorableValue(value)
    ensureFolder('create')
    const path = pathOf(account)
    const temp = join(dir, `.${account}.key.kinfold-new-${process.pid}-${randomBytes(6).toString('hex')}`)
    try {
      trace(`write ${account}`)
      fsCall('create', path, () => writeNewFile(temp, `${value}\n`))
      trace(`link ${account}`)
      try {
        linkSync(temp, path)
      } catch (error: unknown) {
        if (errnoOf(error) === 'EEXIST') return false
        throw failure('create', path, error)
      }
    } finally {
      rmSync(temp, { force: true })
    }
    syncFolder('create')
    return true
  }

  const remove = (account: string): boolean => {
    assertCredentialRef(account)
    if (!folderExists('remove')) return false
    const path = pathOf(account)
    trace(`unlink ${account}`)
    try {
      unlinkSync(path)
    } catch (error: unknown) {
      if (errnoOf(error) === 'ENOENT') return false
      throw failure('remove', path, error)
    }
    syncFolder('remove')
    return true
  }

  const described = (account: string): string => {
    assertCredentialRef(account)
    return pathOf(account)
  }

  return {
    kind: 'key-file',
    label: LABEL,
    place: `the key files in ${tildify(dir, options.homeDir)}`,
    notes: KEY_FILE_NOTES,
    get,
    exists,
    set,
    create,
    delete: remove,
    describeSet: (account) => `${LABEL}: write ${described(account)} (mode 0600, value <hidden>)`,
    describeDelete: (account) => `${LABEL}: remove ${described(account)}`,
    describeEntry: (account) => `the key file ${described(account)}`,
  }
}

type Nearest = { path: string; stats: Stats } | { path: string; code: string }

function nearestExisting(path: string): Nearest {
  let current = path
  for (;;) {
    try {
      return { path: current, stats: lstatSync(current) }
    } catch (error: unknown) {
      const code = errnoOf(error) ?? 'unknown'
      const parent = dirname(current)
      if (code !== 'ENOENT' || parent === current) return { path: current, code }
      current = parent
    }
  }
}

function writableFolder(path: string, stats: Stats): boolean {
  if (!stats.isDirectory()) return false
  try {
    accessSync(path, constants.W_OK | constants.X_OK)
    return true
  } catch {
    return false
  }
}

/** Install only. Never creates anything. */
export function probeKeyFile(deps: KeyStoreDeps): KeyStoreProbe {
  if (deps.platform.os !== 'linux') return { usable: false, reason: 'not Linux' }
  const dir = keyFileDir(deps)
  if (isInside(dir, deps.dataDir)) return { usable: false, reason: reasons.inside(dir, deps.dataDir) }
  const found = nearestExisting(dir)
  if ('code' in found) return { usable: false, reason: reasons.failed('check', found.path, found.code) }
  if (found.path === dir) {
    const unsafe = unsafeFolderReason(dir, found.stats)
    return unsafe === null ? { usable: true } : { usable: false, reason: unsafe }
  }
  return writableFolder(found.path, found.stats) ? { usable: true } : { usable: false, reason: reasons.notWritable(found.path) }
}

export const keyFileModule: KeyStoreModule = {
  kind: 'key-file',
  label: LABEL,
  probe: probeKeyFile,
  open: (deps) => createKeyFileStore(keyFileDir(deps), { dataDir: deps.dataDir, homeDir: deps.homeDir }),
  location: (deps) => keyFileDir({ ...deps, location: undefined }),
}
