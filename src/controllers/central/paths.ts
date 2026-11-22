// Where central memory keeps its files inside a data folder. Every file is
// owner-only: the key files are secrets, and the devices list says who may
// read this memory.

import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { writeFileAtomic } from '../fs/atomic'
import { DATA_FILE_MODE } from '../store/data-dir'

export const CENTRAL_DIR = 'central'
const DIR_MODE = 0o700

export const INVITES_FILE = 'invites.json'
export const DEVICES_FILE = 'devices.json'
export const HUB_KEY_FILE = 'hub-key.pem'
export const DEVICE_KEY_FILE = 'device-key.pem'

export function centralDir(dataDir: string): string {
  const dir = join(dataDir, CENTRAL_DIR)
  mkdirSync(dir, { recursive: true, mode: DIR_MODE })
  chmodSync(dir, DIR_MODE)
  return dir
}

export function centralPath(dataDir: string, file: string): string {
  return join(dataDir, CENTRAL_DIR, file)
}

/** The parsed file, or null when it is missing or does not parse. */
export function readJsonFile(path: string): unknown {
  if (!existsSync(path)) return null
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

export function writePrivateJson(dataDir: string, file: string, value: unknown): void {
  centralDir(dataDir)
  writeFileAtomic(centralPath(dataDir, file), `${JSON.stringify(value, null, 2)}\n`, DATA_FILE_MODE)
}

export function removeCentralFile(dataDir: string, file: string): void {
  rmSync(centralPath(dataDir, file), { force: true })
}
