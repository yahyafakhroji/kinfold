// The real npm shims on Windows. Runs only with KINFOLD_TEST_WINDOWS_SHIM=1:
// the Windows smoke runner installs @anthropic-ai/claude-code and opencode
// with npm, which writes claude.cmd (a node script behind it) and
// opencode.cmd (a program behind it). Each is resolved the way the observer
// resolves it and run with --version, with no shell in between.

import { describe, expect, test } from 'bun:test'
import { currentPlatform } from '../../platform/platform'
import { spawnProcess } from './claude-cli'
import { resolveCmdShim } from './windows-shim'

const LIVE = currentPlatform().os === 'windows' && process.env.KINFOLD_TEST_WINDOWS_SHIM === '1'
const VERSION = /\d+\.\d+\.\d+/

describe.skipIf(!LIVE)('npm .cmd shims (live)', () => {
  for (const cli of ['claude', 'opencode']) {
    test(`${cli} from npm runs through its shim target and answers --version`, async () => {
      const found = Bun.which(cli)
      expect(found).not.toBeNull()
      // npm on Windows always writes a .cmd; a program found first instead would mean this test proves nothing.
      expect(found!.toLowerCase().endsWith('.cmd')).toBe(true)
      const shim = resolveCmdShim(found!)
      expect(shim).not.toBeNull()
      const result = await spawnProcess({ cmd: [...shim!.argv0, '--version'], cwd: process.cwd(), env: { ...process.env } as Record<string, string>, stdin: '', timeoutMs: 60_000 })
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toMatch(VERSION)
    }, 90_000)
  }
})
