import { afterEach, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { USAGE, parseArgs } from '../install/args'
import { HOOK_TIMEOUT_S } from '../install/claude-hooks'
import { EXIT_USAGE } from '../install/install'
import { type FakeWorld, createWorld } from '../install/test-support'
import { SQLITE3MC_LIB_ENV } from '../sqlite/library'
import { VERSION } from '../version'
import { mergeSamHooks } from '../install/claude-hooks'
import { installPaths } from '../install/env'
import { entryCommand } from '../install/entry'
import { type SubcommandRunners, dataDirFor, envForDataDir, runKinfold } from './kinfold'

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
      command: 'install', dryRun: false, yes: true, skipCheck: true, replaceCredential: false, credentialStdin: false, takeover: false, removeCredentials: false, removeHmacKeys: false, noEncrypt: false, noUpdateCheck: false, port: null,
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
    expect(dataDirFor([], {}, home)).toBe(join(home, '.kinfold'))
    for (const command of ['status', 'uninstall', 'dashboard', 'size']) {
      expect(dataDirFor([command], {}, home)).toBe(join(home, '.shared-agent-memory'))
    }
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

const HAND_RUN = { compiled: true, execPath: '/Users/me/My Memory/bin/kinfold', looksInstalled: () => true }

test('the installed program run by hand finds its own folder', () => {
  const home = '/Users/me'
  expect(dataDirFor(['status'], {}, home, HAND_RUN)).toBe('/Users/me/My Memory')
  expect(dataDirFor([], {}, home, HAND_RUN)).toBe('/Users/me/My Memory')
  expect(dataDirFor(['install'], {}, home, HAND_RUN)).toBe('/Users/me/My Memory')
  expect(dataDirFor(['status'], { KINFOLD_DATA_DIR: '/env/dir' }, home, HAND_RUN)).toBe('/env/dir')
  expect(dataDirFor(['status'], { SAM_DATA_DIR: '/old/env' }, home, HAND_RUN)).toBe('/old/env')
  expect(dataDirFor(['--data-dir', '/flag/dir', 'status'], { KINFOLD_DATA_DIR: '/env/dir' }, home, HAND_RUN)).toBe('/flag/dir')
})

test('a program that is not an installed one never claims its folder', () => {
  const home = '/Users/me'
  const unchanged = join(home, '.kinfold')
  expect(dataDirFor(['install'], {}, home, { ...HAND_RUN, compiled: false })).toBe(unchanged)
  expect(dataDirFor(['install'], {}, home, { ...HAND_RUN, looksInstalled: () => false })).toBe(unchanged)
  expect(dataDirFor(['install'], {}, home, { ...HAND_RUN, execPath: '/tmp/kinfold-linux-x64' })).toBe(unchanged)
  expect(dataDirFor(['install'], {}, home, { ...HAND_RUN, execPath: '/usr/local/sbin/kinfold' })).toBe(unchanged)
  // The real check: a bin folder with nothing installed beside it.
  const empty = mkdtempSync(join(tmpdir(), 'kinfold-cli-'))
  try {
    mkdirSync(join(empty, 'bin'))
    expect(dataDirFor(['install'], {}, home, { compiled: true, execPath: join(empty, 'bin', 'kinfold') })).toBe(unchanged)
    writeFileSync(join(empty, 'install.json'), '{}')
    expect(dataDirFor(['install'], {}, home, { compiled: true, execPath: join(empty, 'bin', 'kinfold') })).toBe(empty)
  } finally {
    rmSync(empty, { recursive: true, force: true })
  }
})

test('an injected env with --data-dir rebuilds the program path', async () => {
  world = createWorld()
  const program = (dir: string) => ({ kind: 'program', binPath: join(dir, 'bin', 'kinfold') }) as const
  const env = { ...world.env, dataDir: '/a', mode: program('/a') }
  expect(envForDataDir(env, '/b')).toMatchObject({ dataDir: '/b', mode: { kind: 'program', binPath: '/b/bin/kinfold' } })
  expect(envForDataDir(world.env, '/b').mode).toEqual(world.env.mode)
  // End to end: hooks wired for /b read as wired once status runs with --data-dir /b.
  const paths = installPaths(world.env)
  mkdirSync(paths.claudeDir, { recursive: true })
  writeFileSync(paths.claudeSettings, JSON.stringify(mergeSamHooks({}, { entry: entryCommand(program('/b'), 'hook', '/b') }).settings))
  expect(await runKinfold(['--data-dir', '/b', 'status'], env)).toBe(0)
  expect(world.out.some((line) => line.startsWith('  claude-code:') && line.includes('wired: yes'))).toBe(true)
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

test('a bare kinfold installs, and --help prints usage without installing', async () => {
  world = createWorld({ claudeVersion: '2.1.310 (Claude Code)', interactive: true })

  expect(await runKinfold([], world.env)).toBe(0)
  expect(world.out.at(-1)).toBe('installed. Check it with: bun src/cli/kinfold.ts status')

  world.out.length = 0
  expect(await runKinfold(['--help'], world.env)).toBe(0)
  expect(world.out[0]).toStartWith('usage: kinfold ')
  expect(world.out.at(-1)).not.toBe('installed. Check it with: bun src/cli/kinfold.ts status')
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

test('--data-dir after the subcommand also reaches it', async () => {
  world = createWorld()
  let seen: string | undefined
  const hook = async (): Promise<void> => {
    seen = process.env.KINFOLD_DATA_DIR
  }
  expect(await runKinfold(['hook', '--data-dir', '/tmp/a b'], world.env, { ...recordRunners([]), hook })).toBe(0)
  expect(seen).toBe('/tmp/a b')
})

test('install --data-dir uses the given folder for a dry run', async () => {
  world = createWorld({ claudeVersion: '2.1.310 (Claude Code)', keychainRefs: ['openrouter'] })
  const root = mkdtempSync(join(tmpdir(), 'kinfold-install-dir-'))
  const dir = join(root, 'data')
  try {
    expect(await runKinfold(['install', '--data-dir', dir, '--yes', '--dry-run'], world.env)).toBe(0)
    const plan = world.out.join('\n')
    expect(plan).toContain(`mkdir ${dir} (mode 0700)`)
    expect(existsSync(join(dir, 'memory.db'))).toBe(false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('the daemon subcommand stays up and stops cleanly on SIGTERM', async () => {
  const root = mkdtempSync(join(tmpdir(), 'kinfold-daemon-cli-'))
  const dataDir = join(root, 'data')
  const child = Bun.spawn([process.execPath, join(import.meta.dir, 'kinfold.ts'), '--data-dir', dataDir, 'daemon'], {
    cwd: join(import.meta.dir, '..', '..'),
    env: {
      PATH: process.env.PATH ?? '',
      HOME: root,
      NODE_ENV: 'test',
      KINFOLD_PORT: '0',
      KINFOLD_DB_KEYSTORE: 'none',
      [SQLITE3MC_LIB_ENV]: process.env[SQLITE3MC_LIB_ENV] ?? '',
    },
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const stderr = new Response(child.stderr).text()
  try {
    const deadline = Date.now() + 10_000
    let port: number | null = null
    while (port === null && Date.now() < deadline && child.exitCode === null) {
      const info = join(dataDir, 'daemon.json')
      if (existsSync(info)) {
        try {
          const parsed = JSON.parse(readFileSync(info, 'utf8')) as { port?: unknown }
          if (typeof parsed.port === 'number') port = parsed.port
        } catch {
          // The file is written whole, so a parse error means it is not ready yet.
        }
      }
      if (port === null) await Bun.sleep(25)
    }
    expect(port).not.toBeNull()
    const health = await fetch(`http://127.0.0.1:${port}/health`)
    expect(health.status).toBe(200)
    expect(await health.json()).toMatchObject({ ok: true })
    expect(child.exitCode).toBeNull()
    child.kill('SIGTERM')
    let timer: ReturnType<typeof setTimeout> | null = null
    const timeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), 5_000)
    })
    const exitCode = await Promise.race([child.exited, timeout])
    if (timer !== null) clearTimeout(timer)
    expect(exitCode).toBe(0)
    const log = await stderr
    expect(log).toContain('listening on 127.0.0.1')
    expect(log).toContain('SIGTERM, shutting down')
  } finally {
    if (child.exitCode === null) child.kill('SIGKILL')
    await child.exited.catch(() => {})
    rmSync(root, { recursive: true, force: true })
  }
})

test('the mcp subcommand keeps running while its stdin is open', async () => {
  const root = mkdtempSync(join(tmpdir(), 'kinfold-mcp-cli-'))
  const dataDir = join(root, 'data')
  const child = Bun.spawn([process.execPath, join(import.meta.dir, 'kinfold.ts'), '--data-dir', dataDir, 'mcp'], {
    cwd: join(import.meta.dir, '..', '..'),
    env: {
      PATH: process.env.PATH ?? '',
      HOME: root,
      NODE_ENV: 'test',
      KINFOLD_DB_KEYSTORE: 'none',
      [SQLITE3MC_LIB_ENV]: process.env[SQLITE3MC_LIB_ENV] ?? '',
    },
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  })
  try {
    await Bun.sleep(200)
    expect(child.exitCode).toBeNull()
    await child.stdin.end()
    const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
    expect(exitCode).toBe(0)
    expect(stdout).toBe('')
    expect(stderr).toContain('ready')
    expect(stderr).toContain('stdin closed, exiting')
  } finally {
    if (child.exitCode === null) child.kill('SIGKILL')
    await child.exited.catch(() => {})
    rmSync(root, { recursive: true, force: true })
  }
})

test('a fatal mcp error logs only its name, not the message', async () => {
  const home = mkdtempSync(join(tmpdir(), 'kinfold-mcp-fatal-'))
  try {
    const child = Bun.spawn([process.execPath, join(import.meta.dir, 'kinfold.ts'), 'mcp'], {
      cwd: join(import.meta.dir, '..', '..'),
      env: { PATH: process.env.PATH ?? '', HOME: home, KINFOLD_DATA_DIR: 'relative/path' },
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
    expect(exitCode).toBe(1)
    expect(stdout).toBe('')
    expect(stderr).toContain('kinfold-mcp: fatal Error')
    expect(stderr).not.toContain('must be an absolute path')
    expect(stderr).not.toContain('kinfold:')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
