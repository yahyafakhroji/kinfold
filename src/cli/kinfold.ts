// `bun src/cli/kinfold.ts <install|uninstall|status>` (also `bun run kinfold`), plus the
// data-control commands `size|retention|scan|findings|purge`, which only call
// the daemon's /data routes (src/data-control/cli.ts), and `dashboard`, which
// asks the daemon for a one-time login link (src/dashboard/cli.ts). This is
// the only place that reads the real home dir, environment, uid and bun path;
// everything below gets them through InstallEnv, so tests run the same code
// against a temp home with fake commands. Output is paths, counts, hosts and
// error classes; never a credential or a settings file's contents.

import { homedir } from 'node:os'
import { resolve } from 'node:path'
import { createRunner } from '../observer/runners'
import { createSecurityRunner } from '../secrets/keychain-writer'
import { resolveDataDir } from '../store/data-dir'
import { runDataCommand } from '../data-control/cli'
import { runDashboard } from '../dashboard/cli'
import { parseArgs, parseDashboardArgs, parseDataArgs, parseKeyArgs } from '../install/args'
import { runKeyCommand } from '../install/encrypt'
import type { InstallEnv } from '../install/env'
import { EXIT_FAILED, EXIT_USAGE, install } from '../install/install'
import { status } from '../install/status'
import { createCommandRunner, createPromptIO } from '../install/system'
import { uninstall } from '../install/uninstall'

export async function runKinfold(argv: readonly string[], env: InstallEnv): Promise<number> {
  const dashboard = parseDashboardArgs(argv)
  if (dashboard !== null) {
    if (dashboard.ok) return runDashboard(env, dashboard.value)
    env.out(dashboard.error)
    return EXIT_USAGE
  }
  const key = parseKeyArgs(argv)
  if (key !== null) {
    if (key.ok) return runKeyCommand(env, key.value.command)
    env.out(key.error)
    return EXIT_USAGE
  }
  const data = parseDataArgs(argv)
  if (data !== null) {
    if (data.ok) return runDataCommand(env, data.value)
    env.out(data.error)
    return EXIT_USAGE
  }
  const parsed = parseArgs(argv)
  if (!parsed.ok) {
    env.out(parsed.error)
    return EXIT_USAGE
  }
  const args = parsed.value
  if (args.command === 'status') return status(env)
  if (args.command === 'uninstall') return uninstall(env, { dryRun: args.dryRun, removeCredentials: args.removeCredentials, removeHmacKeys: args.removeHmacKeys })
  return install(env, {
    dryRun: args.dryRun,
    yes: args.yes,
    skipCheck: args.skipCheck,
    replaceCredential: args.replaceCredential,
    credentialStdin: args.credentialStdin,
    takeover: args.takeover,
    hosts: args.hosts,
    flags: args.observers,
  })
}

function systemEnv(): InstallEnv {
  const homeDir = homedir()
  const dataDir = resolveDataDir(process.env)
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
  }
}

async function main(): Promise<void> {
  try {
    process.exit(await runKinfold(process.argv.slice(2), systemEnv()))
  } catch (error: unknown) {
    process.stderr.write(`kinfold: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exit(EXIT_FAILED)
  }
}

if (import.meta.main) await main()
