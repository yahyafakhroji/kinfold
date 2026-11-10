// The real access-list read on Windows. Runs only with
// KINFOLD_TEST_WINDOWS_ACL=1 (the Windows smoke runner sets it). It makes a
// folder under the real profile the way install makes the data folder, reads
// its access list through PowerShell, and removes the folder.

import { describe, expect, test } from 'bun:test'
import { mkdirSync, rmSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { currentPlatform } from '../../platform/platform'
import type { InstallEnv } from '../env'
import { createCommandRunner } from '../system'
import { WINDOWS_QUERY_TIMEOUT_MS, windowsAclAccess } from './windows-acl'

const LIVE = currentPlatform().os === 'windows' && process.env.KINFOLD_TEST_WINDOWS_ACL === '1'
/** install's data folder mode */
const DIR_MODE = 0o700

function childEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value
  return env
}

/** The check reads only these fields of the install env. */
function liveEnv(childVars: Record<string, string>): InstallEnv {
  const env: Pick<InstallEnv, 'envVars' | 'run'> = { envVars: process.env, run: createCommandRunner(childVars) }
  return env as InstallEnv
}

/** What the CLI hands its children (src/cli/kinfold.ts): PATH and HOME, nothing else. */
function statusChildEnv(): Record<string, string> {
  const pathKey = Object.keys(process.env).find((key) => key.toUpperCase() === 'PATH') ?? 'PATH'
  return { PATH: process.env[pathKey] ?? '', HOME: process.env.USERPROFILE ?? '' }
}

async function okLineFor(childVars: Record<string, string>): Promise<void> {
  const profile = process.env.USERPROFILE ?? ''
  expect(profile).not.toBe('')
  const dir = join(profile, `.kinfold-live-${randomBytes(4).toString('hex')}`)
  mkdirSync(dir, { recursive: true, mode: DIR_MODE })
  try {
    const lines = await windowsAclAccess(liveEnv(childVars)).statusLines(dir)
    expect(lines).toEqual([`data dir ${dir}: access list ok (only you, SYSTEM and Administrators can read it)`])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe.skipIf(!LIVE)('Windows access list (live)', () => {
  test('a new folder under the profile gives the access list ok line', async () => {
    await okLineFor(childEnv())
  })

  // A timeout shows as "could not be read (timed out)", so the ok line also proves it beat the limit.
  test('the line is ok within the timeout under the environment status gives its children', async () => {
    await okLineFor(statusChildEnv())
  }, WINDOWS_QUERY_TIMEOUT_MS + 5_000)
})
