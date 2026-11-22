// Creating and migrating a store costs tens of milliseconds, and far more on
// Windows. Tests that need many fresh stores build one per kind per process,
// close it, and copy the closed file into each case's own folder. An
// encrypted copy is rekeyed, so no two stores share a key unless a case asks.

import { cpSync, existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { newDbKey } from '../sqlite/keys'
import { openEncrypted } from '../sqlite/open'
import { DB_FILE } from '../store/data-dir'
import { openStore } from '../store/db'

export type StoreKind = 'encrypted' | 'plain'

interface Template {
  dir: string
  key: string | null
}

const templates = new Map<StoreKind, Template>()
let templateRoot: string | null = null

const fixedKeys = (key: string | null) => (key === null ? { name: 'none', read: () => null, exists: () => false } : { name: 'test', read: () => key, exists: () => true })

function template(kind: StoreKind): Template {
  const built = templates.get(kind)
  if (built !== undefined) return built
  if (templateRoot === null) {
    const dir = mkdtempSync(join(tmpdir(), 'kf-store-template-'))
    templateRoot = dir
    process.on('exit', () => rmSync(dir, { recursive: true, force: true }))
  }
  const dir = join(templateRoot, kind)
  const key = kind === 'encrypted' ? newDbKey() : null
  openStore(dir, { keys: fixedKeys(key) }).db.close()
  // Closed cleanly, the store is one file: no -wal or -shm to copy half-written.
  const files = readdirSync(dir)
  if (files.length !== 1 || files[0] !== DB_FILE) throw new Error(`store template holds ${files.join(', ')}`)
  const made = { dir, key }
  templates.set(kind, made)
  return made
}

/**
 * A fresh, closed, migrated store at `dataDir`, which must not exist yet.
 * An encrypted one gets `key` when given, else a new key of its own.
 */
export function templateStore(kind: StoreKind, dataDir: string, key?: string): { dataDir: string; key: string | null } {
  if (existsSync(dataDir)) throw new Error(`${dataDir} already exists`)
  const source = template(kind)
  cpSync(source.dir, dataDir, { recursive: true })
  if (source.key === null) return { dataDir, key: null }
  const own = key ?? newDbKey()
  const db = openEncrypted(join(dataDir, DB_FILE), source.key)
  try {
    db.exec('PRAGMA journal_mode = DELETE')
    db.exec(`PRAGMA rekey = 'raw:${own}'`)
    db.exec('PRAGMA journal_mode = WAL')
  } finally {
    db.close()
  }
  return { dataDir, key: own }
}
