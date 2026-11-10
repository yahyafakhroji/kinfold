// What a WSL distro remembers about the Windows install it is linked to:
// ~/.kinfold-wsl/wsl-link.json. The distro keeps no memory of its own then; its
// agents run ~/.kinfold-wsl/bin/kinfold against the Windows data folder.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DATA_FILE_MODE } from '../store/data-dir'
import type { Action } from '../install/plan'

/** ~/.kinfold-wsl: bin/kinfold, install.json, wsl-link.json. */
export const WSL_HOME_DIR = '.kinfold-wsl'
export const WSL_LINK_FILE = 'wsl-link.json'

export interface WslLink {
  /** The Windows data folder, as the scheduled task names it (C:\Users\me\.kinfold). */
  windowsDataDir: string
  /** The same folder as a WSL path (/mnt/c/Users/me/.kinfold). */
  dataDir: string
  /** The scheduled task config, as a WSL path. */
  taskConfig: string
  linkedAt: number
}

const LINK_KEYS = ['dataDir', 'linkedAt', 'taskConfig', 'windowsDataDir'] as const

export function wslHomeDir(homeDir: string): string {
  return join(homeDir, WSL_HOME_DIR)
}

const isPath = (value: unknown): value is string => typeof value === 'string' && value !== ''

/** The link in `dir`; null when the file is missing, unreadable, or holds anything but exactly the four keys. */
export function readWslLink(dir: string): WslLink | null {
  let value: unknown
  try {
    value = JSON.parse(readFileSync(join(dir, WSL_LINK_FILE), 'utf8'))
  } catch {
    return null
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  const keys = Object.keys(record).sort()
  if (keys.length !== LINK_KEYS.length || keys.some((key, index) => key !== LINK_KEYS[index])) return null
  const { windowsDataDir, dataDir, taskConfig, linkedAt } = record
  if (!isPath(windowsDataDir) || !isPath(dataDir) || !isPath(taskConfig)) return null
  if (typeof linkedAt !== 'number' || !Number.isFinite(linkedAt)) return null
  return { windowsDataDir, dataDir, taskConfig, linkedAt }
}

export function wslLinkContent(link: WslLink): string {
  const fields: WslLink = { windowsDataDir: link.windowsDataDir, dataDir: link.dataDir, taskConfig: link.taskConfig, linkedAt: link.linkedAt }
  return `${JSON.stringify(fields, null, 2)}\n`
}

/** A write at 0600 with exactly the four keys, in a fixed order. */
export function wslLinkAction(dir: string, link: WslLink): Action {
  return { kind: 'write', path: join(dir, WSL_LINK_FILE), content: wslLinkContent(link), mode: DATA_FILE_MODE, summary: `link this distro to the Windows memory at ${link.windowsDataDir}` }
}
