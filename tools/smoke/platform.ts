// What the smoke driver needs to know about one OS. Each OS adds its own file
// beside this one (macos.ts, linux.ts, windows.ts) exporting smokePlatform; the
// smoke workflow enables an OS only when that file and its runner script exist.

import { existsSync } from 'node:fs'
import { join } from 'node:path'

export class SmokeError extends Error {
  override name = 'SmokeError'
  constructor(readonly step: string, message: string) {
    super(message)
  }
}

export interface SmokeWorld {
  program: string
  root: string
  home: string
  project: string
  dataDir: string
  fakeBin: string
  env: Record<string, string>
  marker: string
}

export interface SmokeResult {
  code: number
  stdout: string
  stderr: string
}

export interface SmokePlatform {
  readonly name: 'macos' | 'linux' | 'windows'
  /** "kinfold" or "kinfold.exe" under <dataDir>/bin. */
  readonly programName: string
  /** The label status prints in "database: encrypted (<label> db-key present)". */
  readonly keyStoreLabel: string
  serviceLoaded(env: Readonly<Record<string, string>>): boolean
  /** Paths uninstall must have removed: the plist, the unit, the task file. */
  serviceFiles(home: string): string[]
  /** The pty run of encrypt or decrypt; omit to use the driver's expect-based one. */
  runConversion?(world: SmokeWorld, operation: 'encrypt' | 'decrypt'): Promise<SmokeResult>
  /**
   * Starts the daemon by hand when the runner has no service manager. The
   * driver starts it after install, stops it before decrypt and before
   * encrypt, starts it again after each, and stops it before uninstall.
   * Omit: the service runs it.
   */
  foregroundDaemon?(world: SmokeWorld): Promise<{ stop(): Promise<void> }>
  /** Extra variables merged into every child's environment (after the driver's own). */
  childEnv?(home: string): Record<string, string>
  /** Replaces the driver's sh observer shim when present. */
  writeObserverShim?(world: SmokeWorld, realClaude: string | null): Promise<void>
}

const PLATFORM_NAME = /^[a-z0-9]+$/

function isMissingModule(error: unknown, path: string): boolean {
  if (typeof error !== 'object' || error === null) return false
  const { code, specifier } = error as { code?: unknown; specifier?: unknown }
  return code === 'ERR_MODULE_NOT_FOUND' && specifier === path
}

function isSmokePlatform(value: unknown): value is SmokePlatform {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Partial<Record<keyof SmokePlatform, unknown>>
  return typeof candidate.name === 'string'
    && typeof candidate.programName === 'string'
    && typeof candidate.keyStoreLabel === 'string'
    && typeof candidate.serviceLoaded === 'function'
    && typeof candidate.serviceFiles === 'function'
}

/**
 * The steps file for one OS. Only a missing file means "no steps yet": a file
 * that fails to build, or one whose own import is missing, must fail the run,
 * or a broken platform file would read as a green gate.
 */
export async function loadSmokePlatform(name: string, dir: string = import.meta.dir): Promise<SmokePlatform> {
  if (!PLATFORM_NAME.test(name)) throw new SmokeError('setup', `${JSON.stringify(name)} is not a platform name`)
  const path = join(dir, `${name}.ts`)
  let loaded: { smokePlatform?: unknown }
  try {
    loaded = await import(path) as { smokePlatform?: unknown }
  } catch (error: unknown) {
    if (isMissingModule(error, path) && !existsSync(path)) throw new SmokeError('setup', `no smoke steps for ${name} yet`)
    throw error
  }
  if (!isSmokePlatform(loaded.smokePlatform)) throw new SmokeError('setup', `the smoke steps for ${name} do not export smokePlatform`)
  return loaded.smokePlatform
}
