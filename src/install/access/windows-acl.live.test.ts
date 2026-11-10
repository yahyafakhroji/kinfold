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
import { windowsAclAccess } from './windows-acl'

const LIVE = currentPlatform().os === 'windows' && process.env.KINFOLD_TEST_WINDOWS_ACL === '1'
/** install's data folder mode */
const DIR_MODE = 0o700

function childEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value
  return env
}

/** The check reads only these fields of the install env. */
function liveEnv(): InstallEnv {
  const env: Pick<InstallEnv, 'envVars' | 'run'> = { envVars: process.env, run: createCommandRunner(childEnv()) }
  return env as InstallEnv
}

describe.skipIf(!LIVE)('Windows access list (live)', () => {
  test('a new folder under the profile gives the access list ok line', async () => {
    const profile = process.env.USERPROFILE ?? ''
    expect(profile).not.toBe('')
    const dir = join(profile, `.kinfold-live-${randomBytes(4).toString('hex')}`)
    mkdirSync(dir, { recursive: true, mode: DIR_MODE })
    try {
      const lines = await windowsAclAccess(liveEnv()).statusLines(dir)
      expect(lines).toEqual([`data dir ${dir}: access list ok (only you, SYSTEM and Administrators can read it)`])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
