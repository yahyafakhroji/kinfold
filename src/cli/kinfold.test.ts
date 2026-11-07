import { afterEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { USAGE, parseArgs } from '../install/args'
import { HOOK_TIMEOUT_S } from '../install/claude-hooks'
import { EXIT_USAGE } from '../install/install'
import { type FakeWorld, createWorld } from '../install/test-support'
import { VERSION } from '../version'
import { type SubcommandRunners, dataDirFor, runKinfold } from './kinfold'

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

test('with only the old data dir, install targets ~/.kinfold and every other command keeps the old dir', () => {
  const home = mkdtempSync(join(tmpdir(), 'kinfold-cli-'))
  try {
    mkdirSync(join(home, '.shared-agent-memory'))
    expect(dataDirFor(['install', '--dry-run'], {}, home)).toBe(join(home, '.kinfold'))
    for (const command of ['status', 'uninstall', 'dashboard', 'size']) {
      expect(dataDirFor([command], {}, home)).toBe(join(home, '.shared-agent-memory'))
    }
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

interface Routed {
  name: string
  argv: readonly string[]
}

/** A full set of subcommand runners that only records which one ran and with what. */
function recordRunners(routed: Routed[]): SubcommandRunners {
  const record = (name: string) => async (argv: readonly string[]): Promise<void> => {
    routed.push({ name, argv })
  }
  return { hook: record('hook'), mcp: record('mcp'), daemon: record('daemon'), observe: record('observe') }
}

test('hook, mcp, daemon and observe get the argv after the subcommand', async () => {
  world = createWorld()
  const routed: Routed[] = []
  expect(await runKinfold(['hook', '--host', 'claude-code'], world.env, recordRunners(routed))).toBe(0)
  expect(await runKinfold(['mcp'], world.env, recordRunners(routed))).toBe(0)
  expect(await runKinfold(['daemon'], world.env, recordRunners(routed))).toBe(0)
  expect(await runKinfold(['observe', '42'], world.env, recordRunners(routed))).toBe(0)
  expect(routed).toEqual([
    { name: 'hook', argv: ['--host', 'claude-code'] },
    { name: 'mcp', argv: [] },
    { name: 'daemon', argv: [] },
    { name: 'observe', argv: ['42'] },
  ])
})

test('usage names every way to run the program, including the subcommands', () => {
  for (const name of ['hook', 'mcp', 'daemon', 'observe']) expect(USAGE).toContain(`  ${name}`)
  expect(USAGE).toContain('--data-dir')
  expect(USAGE).toContain('--version')
})

test('--version prints the build version and starts nothing', async () => {
  world = createWorld()
  const routed: Routed[] = []
  expect(await runKinfold(['--version'], world.env, recordRunners(routed))).toBe(0)
  expect(world.out).toEqual([VERSION])
  expect(routed).toEqual([])
})

test('--data-dir before the subcommand wins over the environment and reaches the subcommand', async () => {
  world = createWorld()
  const previous = process.env.KINFOLD_DATA_DIR
  delete process.env.KINFOLD_DATA_DIR
  try {
    let seen: string | undefined
    const runners = recordRunners([])
    const hook = async (): Promise<void> => {
      seen = process.env.KINFOLD_DATA_DIR
    }
    expect(await runKinfold(['--data-dir', '/tmp/a b', 'hook'], world.env, { ...runners, hook })).toBe(0)
    expect(seen).toBe('/tmp/a b')
    expect(process.env.KINFOLD_DATA_DIR).toBeUndefined()
    expect(dataDirFor(['--data-dir', '/tmp/a b', 'status'], { KINFOLD_DATA_DIR: join(world.home, 'ignored') }, world.home)).toBe('/tmp/a b')
    expect(dataDirFor(['--data-dir=/tmp/c d', 'hook'], {}, world.home)).toBe('/tmp/c d')
  } finally {
    if (previous !== undefined) process.env.KINFOLD_DATA_DIR = previous
  }
})

test('an unknown subcommand after --data-dir still prints usage and exits non-zero', async () => {
  world = createWorld()
  expect(await runKinfold(['--data-dir', '/tmp/a b', 'frobnicate'], world.env)).toBe(EXIT_USAGE)
  expect(world.out.at(-1)).toContain('usage: kinfold')
})

test('kinfold hook with empty stdin finishes inside the host hook timeout', async () => {
  const home = mkdtempSync(join(tmpdir(), 'kinfold-hook-cli-'))
  try {
    const started = performance.now()
    const child = Bun.spawn([process.execPath, join(import.meta.dir, 'kinfold.ts'), 'hook'], {
      cwd: join(import.meta.dir, '..', '..'),
      env: { PATH: process.env.PATH ?? '', HOME: home, KINFOLD_DATA_DIR: home },
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
    const elapsedMs = performance.now() - started
    expect(exitCode).toBe(0)
    expect(stdout).toBe('')
    expect(stderr).toContain('not a JSON hook payload')
    expect(elapsedMs).toBeLessThan(HOOK_TIMEOUT_S * 1000)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('the hook subcommand loads no installer module', async () => {
  const home = mkdtempSync(join(tmpdir(), 'kinfold-hook-load-'))
  try {
    const installerDir = join(import.meta.dir, '..', 'install')
    const probe = join(home, 'probe.ts')
    const loadedFile = join(home, 'loaded.json')
    writeFileSync(probe, [
      "import { writeFileSync } from 'node:fs'",
      "process.on('exit', () => {",
      `  const loaded = Object.keys(require.cache).filter((path) => path.startsWith(${JSON.stringify(installerDir)}))`,
      `  writeFileSync(${JSON.stringify(loadedFile)}, JSON.stringify(loaded))`,
      '})',
    ].join('\n'))
    const child = Bun.spawn([process.execPath, '--preload', probe, join(import.meta.dir, 'kinfold.ts'), 'hook'], {
      cwd: join(import.meta.dir, '..', '..'),
      env: { PATH: process.env.PATH ?? '', HOME: home, KINFOLD_DATA_DIR: home },
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const [, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
    expect(exitCode).toBe(0)
    expect(stderr).toContain('not a JSON hook payload')
    expect(JSON.parse(readFileSync(loadedFile, 'utf8'))).toEqual([])
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
