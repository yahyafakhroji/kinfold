// Everything the installer touches outside its own code arrives in one
// InstallEnv value: the home and data dirs, the platform, the bun binary, the
// checkout, the command runner, the keychain command, the clock, HTTP and the
// prompts. Only src/cli/sam.ts builds the real one; tests build a temp home
// with fakes, so no test can reach ~/.claude, launchctl or the keychain.

import { join } from 'node:path'
import { HOST_VERSIONS_FILE } from '../adapters/host-version'
import { resolveCodexHome } from './codex-home'
import type { CredentialProvider } from '../secrets/credentials'
import type { SecurityRunner } from '../secrets/keychain-writer'
import type { BuildInput } from '../sqlite/build'
import type { ObserverRunner, ObserverSettings } from '../observer/types'

export interface CommandRequest {
  argv: readonly string[]
  timeoutMs?: number
}

export interface CommandResult {
  exitCode: number
  stdout: string
}

/** Runs claude, opencode and launchctl. A binary that is not installed resolves with exit 127. */
export type CommandRunner = (request: CommandRequest) => Promise<CommandResult>

export type HttpFetch = (url: string, init: RequestInit) => Promise<Response>

export interface PromptIO {
  /** False when stdin is not a TTY: questions cannot be asked. */
  interactive: boolean
  ask(question: string): Promise<string>
  /** No echo. The answer goes to the caller only. */
  askSecret(question: string): Promise<string>
  /** All of stdin, for --credential-stdin. */
  readStdin(): Promise<string>
  /** False when stdout is a pipe or a file, so a secret printed there would not stay on a screen. */
  printsToTerminal?: boolean
}

export type RunnerBuilder = (settings: ObserverSettings, credentials: CredentialProvider) => ObserverRunner

export interface InstallEnv {
  homeDir: string
  dataDir: string
  platform: NodeJS.Platform
  /** Absolute bun binary written into hooks and the LaunchAgent (process.execPath by default). */
  bunPath: string
  /** The checkout whose src/ the hooks, plugin and daemon run from. */
  projectRoot: string
  /** Where duplicate project wiring is looked for. */
  cwd: string
  uid: number
  /** PATH for the daemon's LaunchAgent, so it finds `claude`. */
  pathEnv: string
  run: CommandRunner
  security: SecurityRunner
  now: () => number
  sleep: (ms: number) => Promise<void>
  fetch: HttpFetch
  io: PromptIO
  out: (line: string) => void
  runnerFor: RunnerBuilder
  /** The CODEX_HOME the installer runs with; unset or empty means ~/.codex (codex-home.ts). */
  codexHomeEnv?: string
  /** process.arch; picks the pinned sqlite-vec build (P2-A). Default: this process's. */
  arch?: string
  /** Test seam for the sqlite3mc compile (about 10 s); default src/sqlite/build.ts. */
  buildSqlite3mc?: (input: BuildInput) => string
  /** Where Codex.app and Cursor.app are looked for; default /Applications and ~/Applications. */
  applicationsDirs?: readonly string[]
}

export const LAUNCH_AGENT_LABEL = 'dev.shared-agent-memory.daemon'
export const PLUGIN_FILE_NAME = 'shared-agent-memory.js'

export interface InstallPaths {
  claudeDir: string
  claudeSettings: string
  opencodePluginsDir: string
  opencodePlugin: string
  launchAgentsDir: string
  launchAgentPlist: string
  hookScript: string
  pluginEntry: string
  daemonMain: string
  logsDir: string
  logFile: string
  codexDir: string
  /** Codex reads $CODEX_HOME/hooks.json, else ~/.codex/hooks.json; an unusable CODEX_HOME falls back here and codexHomeProblem says why. */
  codexHooks: string
  cursorDir: string
  cursorHooks: string
  /** What `sam install` recorded about each host's version (adapters/host-version.ts). */
  hostVersionsFile: string
}

/** Why Codex cannot be wired with the CODEX_HOME in effect; null when it can. */
export function codexHomeProblem(env: Pick<InstallEnv, 'homeDir' | 'cwd' | 'codexHomeEnv'>): string | null {
  const home = resolveCodexHome(env.codexHomeEnv, env.homeDir, env.cwd)
  return home.ok ? null : home.reason
}

export function installPaths(env: Pick<InstallEnv, 'homeDir' | 'dataDir' | 'projectRoot'> & Partial<Pick<InstallEnv, 'cwd' | 'codexHomeEnv'>>): InstallPaths {
  const codexHome = resolveCodexHome(env.codexHomeEnv, env.homeDir, env.cwd ?? env.homeDir)
  const codexDir = codexHome.ok ? codexHome.dir : join(env.homeDir, '.codex')
  const opencodePluginsDir = join(env.homeDir, '.config', 'opencode', 'plugins')
  const launchAgentsDir = join(env.homeDir, 'Library', 'LaunchAgents')
  const logsDir = join(env.dataDir, 'logs')
  return {
    claudeDir: join(env.homeDir, '.claude'),
    claudeSettings: join(env.homeDir, '.claude', 'settings.json'),
    opencodePluginsDir,
    opencodePlugin: join(opencodePluginsDir, PLUGIN_FILE_NAME),
    launchAgentsDir,
    launchAgentPlist: join(launchAgentsDir, `${LAUNCH_AGENT_LABEL}.plist`),
    hookScript: join(env.projectRoot, 'src', 'cli', 'hook.ts'),
    pluginEntry: join(env.projectRoot, 'src', 'plugins', 'opencode.ts'),
    daemonMain: join(env.projectRoot, 'src', 'daemon', 'main.ts'),
    logsDir,
    logFile: join(logsDir, 'daemon.log'),
    codexDir,
    codexHooks: join(codexDir, 'hooks.json'),
    cursorDir: join(env.homeDir, '.cursor'),
    cursorHooks: join(env.homeDir, '.cursor', 'hooks.json'),
    hostVersionsFile: join(env.dataDir, HOST_VERSIONS_FILE),
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
