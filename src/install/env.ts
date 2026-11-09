// Everything the installer touches outside its own code arrives in one
// InstallEnv value: the home and data dirs, the platform, the install mode
// (a checkout run through bun or an installed program), the command runner,
// the keychain command, the clock, HTTP and the prompts. Only
// src/cli/kinfold.ts builds the real one; tests build a temp home with fakes,
// so no test can reach ~/.claude, launchctl or the keychain.

import { join } from 'node:path'
import { HOST_VERSIONS_FILE } from '../adapters/host-version'
import { LAUNCH_AGENT_LABEL, LEGACY_DATA_DIR_NAME, LEGACY_LAUNCH_AGENT_LABEL, LEGACY_PLUGIN_FILE_NAME, PLUGIN_FILE_NAME } from '../names'
import { resolveCodexHome } from './codex-home'
import type { InstallMode } from './entry'
import type { TerminalIO } from './prompt/terminal'
import type { CredentialProvider } from '../secrets/credentials'
import type { KeyStore } from '../secrets/key-store'
import type { SecurityRunner } from '../secrets/stores/keychain'
import type { ServiceControl } from './service/control'
import type { BuildInput } from '../sqlite/build'
import type { CliObserverRunner } from '../observer/runners/cli-core'
import type { ObserverRunner, ObserverSettings } from '../observer/types'
import { type PlatformInfo, requireOs } from '../platform/platform'

export interface CommandRequest {
  argv: readonly string[]
  timeoutMs?: number
}

export interface CommandResult {
  exitCode: number
  stdout: string
  /** True when the runner killed the command at its timeout. */
  timedOut?: boolean
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
  /** The folder this run would use without --data-dir; the installed one is looked for there too, since --data-dir replaces dataDir. */
  unflaggedDataDir?: string
  platform: NodeJS.Platform
  /** Linux under WSL; read through platformOf, which ignores it on other OSes. */
  wsl?: boolean
  /** The checkout or installed program every host entry runs (entry.ts). */
  mode: InstallMode
  /** The checkout whose src/ the plugin shim and legacy paths use; program installs keep it for those developer paths. */
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
  /** Raw-key terminal for the setup wizard; null unless stdin and stdout are both TTYs. */
  terminal: TerminalIO | null
  out: (line: string) => void
  runnerFor: RunnerBuilder
  /** The only way the installer builds a codex-cli or opencode-cli runner (createCliRunner). */
  cliRunnerFor: (settings: ObserverSettings) => CliObserverRunner
  /** The CODEX_HOME the installer runs with; unset or empty means ~/.codex (codex-home.ts). */
  codexHomeEnv?: string
  /** process.arch; picks the pinned sqlite-vec build. Default: this process's. */
  arch?: string
  /** Test seam for the sqlite3mc compile (about 10 s); default src/sqlite/build.ts. */
  buildSqlite3mc?: (input: BuildInput) => string
  /** Test seam for the migration's one data dir rename; default fs.renameSync. */
  renameDir?: (from: string, to: string) => void
  /** Where Codex.app and Cursor.app are looked for; default /Applications and ~/Applications. */
  applicationsDirs?: readonly string[]
  /** The background service; default serviceFor(env). null: this platform has none. Tests inject a fake. */
  service?: ServiceControl | null
  /** Whether 127.0.0.1:<port> can be bound; default binds it and lets go at once. A port our own daemon holds counts as free whatever this says. */
  portFree?: (port: number) => Promise<boolean>
  /** Test seam for the bin folder's fsync after the program rename; default fs.fsyncSync. */
  fsyncDir?: (fd: number) => void
  /** The installer's own environment variables, for the SAM_* deprecation checks; default none. Never printed. */
  envVars?: Readonly<Record<string, string | undefined>>
  /**
   * The key store every step of this run uses. Unset: the one key-store.json in dataDir names
   * (key-store-choice.ts). null: none, so credentials are not stored. install sets it once, before the questions.
   */
  keyStore?: KeyStore | null
}

export { LAUNCH_AGENT_LABEL, PLUGIN_FILE_NAME }

export interface InstallPaths {
  claudeDir: string
  claudeSettings: string
  opencodePluginsDir: string
  opencodePlugin: string
  legacyOpencodePlugin: string
  launchAgentsDir: string
  launchAgentPlist: string
  /** The plist an install under the old name left behind; migration removes it. */
  legacyLaunchAgentPlist: string
  pluginEntry: string
  logsDir: string
  logFile: string
  codexDir: string
  /** Codex reads $CODEX_HOME/hooks.json, else ~/.codex/hooks.json; an unusable CODEX_HOME falls back here and codexHomeProblem says why. */
  codexHooks: string
  cursorDir: string
  cursorHooks: string
  /** What `kinfold install` recorded about each host's version (adapters/host-version.ts). */
  hostVersionsFile: string
  /** The data dir under the old name; migration moves it. */
  legacyDataDir: string
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
    legacyOpencodePlugin: join(opencodePluginsDir, LEGACY_PLUGIN_FILE_NAME),
    launchAgentsDir,
    launchAgentPlist: join(launchAgentsDir, `${LAUNCH_AGENT_LABEL}.plist`),
    legacyLaunchAgentPlist: join(launchAgentsDir, `${LEGACY_LAUNCH_AGENT_LABEL}.plist`),
    pluginEntry: join(env.projectRoot, 'src', 'plugins', 'opencode.ts'),
    logsDir,
    logFile: join(logsDir, 'daemon.log'),
    codexDir,
    codexHooks: join(codexDir, 'hooks.json'),
    cursorDir: join(env.homeDir, '.cursor'),
    cursorHooks: join(env.homeDir, '.cursor', 'hooks.json'),
    hostVersionsFile: join(env.dataDir, HOST_VERSIONS_FILE),
    legacyDataDir: join(env.homeDir, LEGACY_DATA_DIR_NAME),
  }
}

/** The platform this env describes; WSL counts only on Linux. */
export function platformOf(env: Pick<InstallEnv, 'platform' | 'wsl'>): PlatformInfo {
  const os = requireOs(env.platform)
  return { os, wsl: os === 'linux' && env.wsl === true, node: env.platform }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
