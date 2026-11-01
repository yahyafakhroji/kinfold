import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { backupPath, foundBackupPath } from '../sqlite/convert'
import { BACKUP_INFIX, existingBackups, plannedBackup } from './files'

const withDir = (run: (dir: string) => void): void => {
  const dir = mkdtempSync(join(tmpdir(), 'kinfold-legacy-names-'))
  try {
    run(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('a backup written by the pre-rename version is still found, and blocks a second one', () => {
  withDir((dir) => {
    const file = join(dir, 'hmac.key')
    writeFileSync(file, 'k')
    const old = `${file}.sam-backup-20260901T000000Z`
    const fresh = `${file}${BACKUP_INFIX}20260902T000000Z`
    writeFileSync(old, 'k')
    expect(existingBackups(file)).toEqual([old])
    expect(plannedBackup(file, 0)).toBeNull()
    writeFileSync(fresh, 'k')
    expect(existingBackups(file).sort()).toEqual([fresh, old].sort())
  })
})

test('new backups carry the kinfold name', () => {
  withDir((dir) => {
    const file = join(dir, 'hmac.key')
    writeFileSync(file, 'k')
    expect(plannedBackup(file, 0)).toContain('.kinfold-backup-')
  })
})

test('the convert backup is found under either name', () => {
  withDir((dir) => {
    const db = join(dir, 'memory.db')
    expect(foundBackupPath(db)).toBe(`${db}.kinfold-convert-backup`)
    writeFileSync(`${db}.sam-convert-backup`, 'old')
    expect(foundBackupPath(db)).toBe(`${db}.sam-convert-backup`)
    writeFileSync(backupPath(db), 'new')
    expect(foundBackupPath(db)).toBe(`${db}.kinfold-convert-backup`)
  })
})
