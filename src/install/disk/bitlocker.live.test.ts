// The real BitLocker check on Windows. Runs only with KINFOLD_TEST_WINDOWS_DISK=1
// (the Windows smoke runner sets it). It reads the system drive's
// BitLockerProtection value through PowerShell once with piped output, the way
// status runs it, and once from a process under conhost --headless, the
// console the scheduled task gives the daemon.

import { describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { currentPlatform } from '../../platform/platform'
import type { InstallEnv } from '../env'
import { createCommandRunner } from '../system'
import { windowsSystemTool } from '../windows-system-path'
import { bitlockerCheck } from './bitlocker'
import { diskEncryptionLine } from './check'

const LIVE = currentPlatform().os === 'windows' && process.env.KINFOLD_TEST_WINDOWS_DISK === '1'
const HEADLESS_TIMEOUT_MS = 90_000
/** What a readable BitLockerProtection value gives; "could not check" and "state unknown" mean the read failed. */
const READ_LINE = /^(disk encryption: BitLocker on|warning: BitLocker is off; .+|disk encryption: BitLocker state \d+ on [A-Z]:)$/

function childEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value
  return env
}

function systemDriveRoot(): string {
  return `${process.env.SystemDrive ?? 'C:'}\\`
}

/** The check reads only these fields of the install env. */
function liveEnv(dataDir: string): InstallEnv {
  const env: Pick<InstallEnv, 'dataDir' | 'envVars' | 'run'> = { dataDir, envVars: process.env, run: createCommandRunner(childEnv()) }
  return env as InstallEnv
}

function moduleUrl(relative: string): string {
  return JSON.stringify(pathToFileURL(join(import.meta.dir, relative)).href)
}

describe.skipIf(!LIVE)('BitLocker (live)', () => {
  test('the system drive gives a BitLocker line from a real value', async () => {
    const state = await bitlockerCheck.check(liveEnv(systemDriveRoot()))
    expect(diskEncryptionLine('BitLocker', state)).toMatch(READ_LINE)
  })

  test('the value still reads from a process under conhost --headless', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kinfold-bitlocker-live-'))
    try {
      const script = join(dir, 'check.ts')
      const out = join(dir, 'line.txt')
      writeFileSync(script, [
        `import { bitlockerCheck } from ${moduleUrl('bitlocker.ts')}`,
        `import { diskEncryptionLine } from ${moduleUrl('check.ts')}`,
        `import { createCommandRunner } from ${moduleUrl('../system.ts')}`,
        'const env: Record<string, string> = {}',
        'for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value',
        `const state = await bitlockerCheck.check({ dataDir: ${JSON.stringify(systemDriveRoot())}, envVars: process.env, run: createCommandRunner(env) } as never)`,
        'await Bun.write(process.env.KINFOLD_LIVE_OUT ?? "", diskEncryptionLine("BitLocker", state) ?? "no line")',
        '',
      ].join('\n'))
      const conhost = windowsSystemTool({ envVars: process.env }, 'System32\\conhost.exe')
      // A headless conhost reads its input from stdin and closes at its end,
      // so stdin stays an open pipe until the child is done; its screen output
      // arrives on stdout and is drained unread.
      const child = Bun.spawn([conhost, '--headless', process.execPath, script], {
        env: { ...childEnv(), KINFOLD_LIVE_OUT: out },
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: 'ignore',
      })
      const timer = setTimeout(() => child.kill(), HEADLESS_TIMEOUT_MS)
      let code: number
      try {
        ;[, code] = await Promise.all([new Response(child.stdout).arrayBuffer(), child.exited])
      } finally {
        clearTimeout(timer)
        await child.stdin.end()
      }
      expect({ code, wrote: existsSync(out) }).toEqual({ code: 0, wrote: true })
      expect(readFileSync(out, 'utf8')).toMatch(READ_LINE)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, HEADLESS_TIMEOUT_MS + 10_000)
})
