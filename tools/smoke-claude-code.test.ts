// Runs .github/smoke/claude-code.sh in bash against fake npm, node and claude
// programs in a temp folder, so no test reaches the registry or a real install.

import { afterEach, describe, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SMOKE_DIR = join(import.meta.dir, '..', '.github', 'smoke')
const HELPER = join(SMOKE_DIR, 'claude-code.sh')
const NATIVE_MESSAGE = 'Error: claude native binary not installed. Either postinstall did not run or the platform-native optional dependency was not downloaded.'

// On Windows `bash` can resolve to WSL's launcher, which sees none of these
// Windows paths; the smoke's Windows setup runs this helper itself.
const shellTest = process.platform === 'win32' ? test.skip : test

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

interface Fakes {
  // Number of npm calls that fail before one succeeds.
  npmFailures: number
  // What claude --version does: 'ok', 'native' (native-binary error until
  // install.cjs has run), 'native-always', or 'other'.
  claude: 'ok' | 'native' | 'native-always' | 'other'
}

function world(fakes: Fakes): { root: string, bin: string, pkg: string, log: string } {
  const root = mkdtempSync(join(tmpdir(), 'kinfold-smoke-claude-'))
  roots.push(root)
  const bin = join(root, 'bin')
  const pkg = join(root, 'pkg')
  const log = join(root, 'calls.log')
  mkdirSync(bin)
  mkdirSync(pkg)
  writeFileSync(log, '')
  const script = (name: string, body: string): void => {
    writeFileSync(join(bin, name), `#!/usr/bin/env bash\n${body}\n`)
    chmodSync(join(bin, name), 0o755)
  }
  script('npm', `
echo "npm $*" >> "${log}"
count=$(grep -c '^npm ' "${log}")
if [ "$count" -le ${fakes.npmFailures} ]; then echo "npm ERR! network" >&2; exit 1; fi
echo "added 5 packages"`)
  script('node', `
echo "node $*" >> "${log}"
touch "${root}/installed"`)
  const claudeBody = {
    ok: 'echo "2.1.326 (Claude Code)"',
    native: `if [ -f "${root}/installed" ]; then echo "2.1.326 (Claude Code)"; else echo "${NATIVE_MESSAGE}" >&2; exit 1; fi`,
    'native-always': `echo "${NATIVE_MESSAGE}" >&2; exit 1`,
    other: 'echo "Error: something else broke" >&2; exit 1',
  }[fakes.claude]
  script('claude', `echo "claude $*" >> "${log}"\n${claudeBody}`)
  return { root, bin, pkg, log }
}

function run(fakes: Fakes, body: string): { code: number, out: string, calls: string[] } {
  const w = world(fakes)
  const result = Bun.spawnSync(['bash', '-c', `set -eo pipefail\nsource "${HELPER}"\n${body.replaceAll('$PKG', w.pkg)}`], {
    env: { ...process.env, PATH: `${w.bin}:${process.env.PATH ?? ''}`, CLAUDE_CODE_INSTALL_BACKOFF_SECONDS: '0' },
  })
  const out = `${result.stdout.toString()}${result.stderr.toString()}`
  const calls = readFileSync(w.log, 'utf8').split('\n').filter((line) => line !== '')
  return { code: result.exitCode ?? -1, out, calls }
}

describe('npm_install_retrying', () => {
  shellTest('retries a failed install and passes a fetch timeout', () => {
    const { code, calls } = run({ npmFailures: 2, claude: 'ok' }, 'npm_install_retrying --global "$CLAUDE_CODE_PACKAGE"')
    expect(code).toBe(0)
    expect(calls.length).toBe(3)
    for (const call of calls) {
      expect(call).toContain('install')
      expect(call).toContain('--fetch-timeout=')
      expect(call).toContain('@anthropic-ai/claude-code@2.1.326')
    }
  })

  shellTest('gives up after three tries with one clear line', () => {
    const { code, out, calls } = run({ npmFailures: 9, claude: 'ok' }, 'npm_install_retrying --global "$CLAUDE_CODE_PACKAGE"')
    expect(code).not.toBe(0)
    expect(calls.length).toBe(3)
    expect(out).toContain('npm install failed 3 times')
  })
})

describe('check_claude_runs', () => {
  shellTest('passes without running install.cjs when claude starts', () => {
    const { code, calls } = run({ npmFailures: 0, claude: 'ok' }, 'check_claude_runs claude "$PKG"')
    expect(code).toBe(0)
    expect(calls.filter((call) => call.startsWith('node '))).toEqual([])
  })

  shellTest('runs the package install.cjs once on the native-binary error, then passes', () => {
    const { code, calls } = run({ npmFailures: 0, claude: 'native' }, 'check_claude_runs claude "$PKG"')
    expect(code).toBe(0)
    const nodeCalls = calls.filter((call) => call.startsWith('node '))
    expect(nodeCalls.length).toBe(1)
    expect(nodeCalls[0]).toContain('install.cjs')
    expect(calls.filter((call) => call.startsWith('claude ')).length).toBe(2)
  })

  shellTest('fails with one clear line when install.cjs does not fix it', () => {
    const { code, out, calls } = run({ npmFailures: 0, claude: 'native-always' }, 'check_claude_runs claude "$PKG"')
    expect(code).not.toBe(0)
    expect(calls.filter((call) => call.startsWith('node ')).length).toBe(1)
    expect(out).toContain('claude --version still fails after running install.cjs')
  })

  shellTest('fails without install.cjs on any other error', () => {
    const { code, out, calls } = run({ npmFailures: 0, claude: 'other' }, 'check_claude_runs claude "$PKG"')
    expect(code).not.toBe(0)
    expect(calls.filter((call) => call.startsWith('node '))).toEqual([])
    expect(out).toContain('claude --version failed')
  })
})

describe('smoke setup scripts', () => {
  for (const smoke of ['macos', 'linux', 'windows']) {
    test(`${smoke}.sh installs the pinned claude-code through the helper`, () => {
      const text = readFileSync(join(SMOKE_DIR, `${smoke}.sh`), 'utf8')
      expect(text).toContain('/claude-code.sh"')
      expect(text).toContain('npm_install_retrying')
      expect(text).toContain('check_claude_runs')
      expect(text).toContain('$CLAUDE_CODE_PACKAGE')
      // Every npm install goes through the retrying helper with the pinned package.
      expect(text).not.toMatch(/\bnpm install\b/)
    })
  }

  test('the helper pins one exact claude-code version', () => {
    expect(existsSync(HELPER)).toBe(true)
    expect(readFileSync(HELPER, 'utf8')).toMatch(/^CLAUDE_CODE_VERSION=\d+\.\d+\.\d+$/m)
  })
})
