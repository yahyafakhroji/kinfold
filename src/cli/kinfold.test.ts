import { afterEach, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseArgs } from '../install/args'
import { EXIT_USAGE } from '../install/install'
import { type FakeWorld, createWorld } from '../install/test-support'
import { runKinfold } from './kinfold'

let world: FakeWorld | null = null
afterEach(async () => {
  await world?.cleanup()
  world = null
})

test('--yes, --hosts and repeated --observer parse into one value', () => {
  const parsed = parseArgs(['install', '--yes', '--hosts', 'claude-code,opencode', '--observer', 'claude-code=claude-cli:sonnet', '--observer=opencode=openrouter:anthropic/claude-haiku:beta', '--skip-check'])
  expect(parsed).toEqual({
    ok: true,
    value: {
      command: 'install', dryRun: false, yes: true, skipCheck: true, replaceCredential: false, credentialStdin: false, takeover: false, removeCredentials: false, removeHmacKeys: false,
      hosts: ['claude-code', 'opencode'],
      observers: [
        { host: 'claude-code', provider: 'claude-cli', model: 'sonnet' },
        { host: 'opencode', provider: 'openrouter', model: 'anthropic/claude-haiku:beta' },
      ],
    },
  })
})

test('bad flags are usage errors that name the problem', () => {
  const error = (argv: string[]): string => {
    const parsed = parseArgs(argv)
    return parsed.ok ? 'parsed' : parsed.error
  }
  expect(error(['install', '--observer', 'zed=claude-cli:haiku'])).toStartWith('--observer takes <host>=<provider>:<model>')
  expect(error(['install', '--observer', 'opencode=gpt:x'])).toContain('needs <provider>:<model> with a known provider')
  expect(error(['install', '--observer', 'opencode=openrouter:'])).toContain('needs <provider>:<model>')
  expect(error(['install', '--observer', 'opencode=claude-cli:a', '--observer', 'opencode=claude-cli:b'])).toBe('--observer given twice for opencode')
  expect(error(['install', '--hosts', 'zed'])).toStartWith('--hosts takes a comma list')
  expect(error(['install', '--observer'])).toBe('--observer needs a value')
  expect(error(['status', '--dry-run'])).toBe('--dry-run does not apply to status')
  expect(error(['uninstall', '--yes'])).toBe('--yes does not apply to uninstall')
  expect(error(['install', '--force'])).toStartWith('unknown argument "--force"')
  expect(error([])).toStartWith('usage: kinfold ')
})

test('runKinfold exits 2 on a usage error and dispatches status', async () => {
  world = createWorld()
  expect(await runKinfold(['frobnicate'], world.env)).toBe(EXIT_USAGE)
  expect(world.out[0]).toStartWith('usage:')
  expect(await runKinfold(['status'], world.env)).toBe(0)
  expect(world.out).toContain('hosts:')
})

test('a failed check under --yes makes `kinfold install` exit non-zero', async () => {
  world = createWorld({ claudeVersion: '2.1.310 (Claude Code)', runner: () => ({ run: async () => Promise.reject(new Error('boom')) }) })
  expect(await runKinfold(['install', '--yes'], world.env)).toBe(1)
  expect(world.out.at(-1)).toBe('install failed: observer check for claude-code failed: internal')
})

test('no non-test source file still tells the user to run `sam <command>`', () => {
  const stale = /\bsam (install|uninstall|status|encrypt|decrypt|rekey|key|size|retention|scan|findings|purge|dashboard)\b/
  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory() ? walk(join(dir, entry.name)) : entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') ? [join(dir, entry.name)] : [])
  const stderrPrefix = /`sam: /
  const hits = walk(join(import.meta.dir, '..')).filter((file) => stale.test(readFileSync(file, 'utf8')) || stderrPrefix.test(readFileSync(file, 'utf8')))
  expect(hits).toEqual([])
})
