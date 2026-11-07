// `kinfold <command>` (also `bun run kinfold`). One program serves every role:
// `hook`, `mcp`, `daemon` and `observe` start the programs that hosts wire up,
// while `install|uninstall|status`, the data-control commands
// `size|retention|scan|findings|purge` (src/data-control/cli.ts), `dashboard`
// (src/dashboard/cli.ts) and the `key` family stay in this process.
//
// Only the store location is read here at startup. Each command's modules are
// imported when that command runs, so a hook pays for the hook alone and never
// the installer, keychain or sqlite build. `--data-dir` is read from the whole
// argv and removed before the command runs: it is the path every command then
// resolves, so nothing can fall back to another store mid-run.

import { homedir } from 'node:os'
import { isAbsolute, resolve } from 'node:path'
import type { Parsed } from '../context/types'
import { envName } from '../env-names'
import type { InstallEnv } from '../install/env'
import { resolveDataDir, resolveInstallDataDir } from '../store/data-dir'
import { VERSION } from '../version'

/** Repeated rather than imported from the installer, which the hook path must not load. */
const EXIT_FAILED = 1
const EXIT_USAGE = 2

export type SubcommandName = 'hook' | 'mcp' | 'daemon' | 'observe'

/** The four entry points that run another program in this one. */
export interface SubcommandRunners {
  hook(argv: readonly string[]): Promise<void>
  mcp(argv: readonly string[]): Promise<void>
  daemon(argv: readonly string[]): Promise<void>
  observe(argv: readonly string[]): Promise<void>
}

const SUBCOMMANDS: readonly SubcommandName[] = ['hook', 'mcp', 'daemon', 'observe']

function isSubcommand(value: string | undefined): value is SubcommandName {
  return value !== undefined && (SUBCOMMANDS as readonly string[]).includes(value)
}

async function loadSubcommand(name: SubcommandName): Promise<SubcommandRunners[SubcommandName]> {
  switch (name) {
    case 'hook': return (await import('./hook')).runHookCli
    case 'mcp': return (await import('../mcp/server')).runMcpServer
    case 'daemon': return (await import('../daemon/main')).runDaemon
    case 'observe': return (await import('../observer/once')).runObserveOnce
  }
}

export interface GlobalArgs {
  /** Set by `--data-dir`; wins over KINFOLD_DATA_DIR and SAM_DATA_DIR. */
  dataDir: string | null
  version: boolean
  /** The command and its arguments, with the global flags removed. */
  argv: string[]
}

/**
 * Reads the global flags wherever they appear, so a hook or a daemon can take
 * `--data-dir` after its name too. The rest keeps its order and reaches the
 * command untouched.
 */
export function parseGlobalArgs(argv: readonly string[]): Parsed<GlobalArgs> {
  let dataDir: string | null = null
  let version = false
  const rest: string[] = []
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? ''
    if (arg === '--version') {
      version = true
      continue
    }
    if (arg === '--data-dir' || arg.startsWith('--data-dir=')) {
      const inline = arg.startsWith('--data-dir=')
      const value = inline ? arg.slice('--data-dir='.length) : argv[index + 1]
      if (value === undefined || value === '') return { ok: false, error: '--data-dir needs a value' }
      if (!isAbsolute(value)) return { ok: false, error: '--data-dir must be an absolute path' }
      if (dataDir !== null) return { ok: false, error: '--data-dir given twice' }
      dataDir = value
      if (!inline) index += 1
      continue
    }
    rest.push(arg)
  }
  return { ok: true, value: { dataDir, version, argv: rest } }
}

/**
 * `env` is the caller's already-built environment (tests); the real CLI leaves
 * it out, so the modules behind an installer command load only when one runs.
 */
export async function runKinfold(argv: readonly string[], env?: InstallEnv, runners: Partial<SubcommandRunners> = {}): Promise<number> {
  const write = env?.out ?? ((line: string): void => {
    process.stdout.write(`${line}\n`)
  })
  const global = parseGlobalArgs(argv)
  if (!global.ok) {
    write(global.error)
    return EXIT_USAGE
  }
  if (global.value.version) {
    write(VERSION)
    return 0
  }
  const args = global.value.argv
  const name = args[0]
  if (isSubcommand(name)) {
    const run = runners[name] ?? (await loadSubcommand(name))
    await withDataDir(global.value.dataDir, () => run(args.slice(1)))
    return 0
  }
  const base = env ?? (await systemEnv(argv))
  const effective = global.value.dataDir === null ? base : { ...base, dataDir: global.value.dataDir }
  const { parseArgs, parseDashboardArgs, parseDataArgs, parseKeyArgs } = await import('../install/args')
  const dashboard = parseDashboardArgs(args)
  if (dashboard !== null) {
    if (!dashboard.ok) {
      effective.out(dashboard.error)
      return EXIT_USAGE
    }
    const { runDashboard } = await import('../dashboard/cli')
    return runDashboard(effective, dashboard.value)
  }
  const key = parseKeyArgs(args)
  if (key !== null) {
    if (!key.ok) {
      effective.out(key.error)
      return EXIT_USAGE
    }
    const { runKeyCommand } = await import('../install/encrypt')
    return runKeyCommand(effective, key.value.command)
  }
  const data = parseDataArgs(args)
  if (data !== null) {
    if (!data.ok) {
      effective.out(data.error)
      return EXIT_USAGE
    }
    const { runDataCommand } = await import('../data-control/cli')
    return runDataCommand(effective, data.value)
  }
  const parsed = parseArgs(args)
  if (!parsed.ok) {
    effective.out(parsed.error)
    return EXIT_USAGE
  }
  const installArgs = parsed.value
  if (installArgs.command === 'status') {
    const { status } = await import('../install/status')
    return status(effective)
  }
  if (installArgs.command === 'uninstall') {
    const { uninstall } = await import('../install/uninstall')
    return uninstall(effective, { dryRun: installArgs.dryRun, removeCredentials: installArgs.removeCredentials, removeHmacKeys: installArgs.removeHmacKeys })
  }
  const { install } = await import('../install/install')
  return install(effective, {
    dryRun: installArgs.dryRun,
    yes: installArgs.yes,
    skipCheck: installArgs.skipCheck,
    replaceCredential: installArgs.replaceCredential,
    credentialStdin: installArgs.credentialStdin,
    takeover: installArgs.takeover,
    hosts: installArgs.hosts,
    flags: installArgs.observers,
  })
}

/**
 * Applies `--data-dir` to the process for the duration of a subcommand, so
 * resolveDataDir inside it selects this store and nothing else. Restored
 * afterwards because callers such as tests run more than one command.
 */
async function withDataDir(dataDir: string | null, run: () => Promise<void>): Promise<void> {
  if (dataDir === null) {
    await run()
    return
  }
  const key = envName('DATA_DIR')
  const previous = process.env[key]
  process.env[key] = dataDir
  try {
    await run()
  } finally {
    if (previous === undefined) delete process.env[key]
    else process.env[key] = previous
  }
}

/** `install` (and the migration it runs) targets ~/.kinfold; every other command finds a store not yet migrated. */
export function dataDirFor(argv: readonly string[], env: Readonly<Record<string, string | undefined>>, home: string): string {
  const global = parseGlobalArgs(argv)
  if (!global.ok) throw new Error(global.error)
  const configured = global.value.dataDir
  const effective = configured === null ? env : { ...env, [envName('DATA_DIR')]: configured }
  return global.value.argv[0] === 'install' ? resolveInstallDataDir(effective, home) : resolveDataDir(effective, home)
}

async function systemEnv(argv: readonly string[]): Promise<InstallEnv> {
  const [{ createCliRunner, createRunner }, { NO_CREDENTIALS }, { createSecurityRunner }, { createCommandRunner, createPromptIO }] = await Promise.all([
    import('../observer/runners'),
    import('../secrets/credentials'),
    import('../secrets/keychain-writer'),
    import('../install/system'),
  ])
  const homeDir = homedir()
  const dataDir = dataDirFor(argv, process.env, homeDir)
  const pathEnv = process.env.PATH ?? '/usr/bin:/bin'
  return {
    homeDir,
    dataDir,
    platform: process.platform,
    bunPath: process.execPath,
    projectRoot: resolve(import.meta.dir, '..', '..'),
    cwd: process.cwd(),
    codexHomeEnv: process.env.CODEX_HOME,
    arch: process.arch,
    uid: process.getuid?.() ?? -1,
    pathEnv,
    run: createCommandRunner({ PATH: pathEnv, HOME: homeDir }),
    security: createSecurityRunner(homeDir),
    now: Date.now,
    sleep: (ms) => Bun.sleep(ms),
    fetch: (url, init) => fetch(url, init),
    io: createPromptIO(),
    out: (line) => process.stdout.write(`${line}\n`),
    runnerFor: (settings, credentials) => createRunner(settings, { dataDir, credentials, parentEnv: process.env }),
    cliRunnerFor: (settings) => createCliRunner(settings, { dataDir, credentials: NO_CREDENTIALS, parentEnv: process.env }),
    envVars: process.env,
  }
}

async function main(): Promise<void> {
  try {
    const argv = process.argv.slice(2)
    process.exit(await runKinfold(argv))
  } catch (error: unknown) {
    process.stderr.write(`kinfold: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exit(EXIT_FAILED)
  }
}

if (import.meta.main) await main()
