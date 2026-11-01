// The daemon as a per-user LaunchAgent (macOS). ProgramArguments is the
// absolute bun plus the absolute src/daemon/main.ts; launchd starts it at
// login and restarts it if it dies. Its log goes to <dataDir>/logs/daemon.log,
// which the installer creates 0600 first, because launchd opens that file
// before the daemon can set its umask. PATH carries the installer's absolute
// entries so the claude-cli observer finds `claude`.

import { delimiter, dirname, isAbsolute } from 'node:path'
import { envName } from '../env-names'
import { LEGACY_LAUNCH_AGENT_LABEL } from '../names'
import { type InstallEnv, LAUNCH_AGENT_LABEL, installPaths } from './env'

/** 0o077 as launchd's decimal Umask key. */
const OWNER_ONLY_UMASK = 63
/** Absolute, so a PATH entry cannot stand in for it. */
export const LAUNCHCTL = '/bin/launchctl'

function escapeXml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

const str = (value: string): string => `<string>${escapeXml(value)}</string>`

/** What the daemon itself runs: the claude-cli observer and git for project keys. */
const DAEMON_TOOLS = ['claude', 'git'] as const
const SYSTEM_DIRS = ['/usr/bin', '/bin', '/usr/sbin', '/sbin'] as const

export type Which = (command: string, path: string) => string | null

const bunWhich: Which = (command, path) => Bun.which(command, { PATH: path })

/**
 * The bun directory, the directories holding the daemon's tools on the
 * installer's PATH, then the system dirs. Copying the whole PATH made the plist
 * depend on which shell ran the installer (`bun run` alone adds seven
 * node_modules/.bin entries), so every re-install rewrote it and restarted the daemon.
 */
export function launchdPath(env: Pick<InstallEnv, 'bunPath' | 'pathEnv'>, which: Which = bunWhich): string {
  const tools = DAEMON_TOOLS.map((tool) => which(tool, env.pathEnv)).filter((found): found is string => found !== null)
  const entries = [dirname(env.bunPath), ...tools.map((found) => dirname(found)), ...SYSTEM_DIRS]
  return [...new Set(entries.filter((entry) => entry !== '' && isAbsolute(entry)))].join(delimiter)
}

export function plistContent(env: Pick<InstallEnv, 'bunPath' | 'pathEnv' | 'homeDir' | 'dataDir' | 'projectRoot'>): string {
  const paths = installPaths(env)
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    `  <key>Label</key>${str(LAUNCH_AGENT_LABEL)}`,
    '  <key>ProgramArguments</key>',
    `  <array>${str(env.bunPath)}${str(paths.daemonMain)}</array>`,
    '  <key>RunAtLoad</key><true/>',
    '  <key>KeepAlive</key><true/>',
    `  <key>WorkingDirectory</key>${str(env.dataDir)}`,
    `  <key>StandardOutPath</key>${str(paths.logFile)}`,
    `  <key>StandardErrorPath</key>${str(paths.logFile)}`,
    `  <key>Umask</key><integer>${OWNER_ONLY_UMASK}</integer>`,
    '  <key>ProcessType</key><string>Background</string>',
    '  <key>EnvironmentVariables</key>',
    '  <dict>',
    `    <key>${envName('DATA_DIR')}</key>${str(env.dataDir)}`,
    `    <key>PATH</key>${str(launchdPath(env))}`,
    `    <key>HOME</key>${str(env.homeDir)}`,
    '  </dict>',
    '</dict>',
    '</plist>',
    '',
  ].join('\n')
}

export function guiDomain(uid: number): string {
  return `gui/${uid}`
}

export function bootstrapArgv(env: Pick<InstallEnv, 'uid' | 'homeDir' | 'dataDir' | 'projectRoot'>): string[] {
  return [LAUNCHCTL, 'bootstrap', guiDomain(env.uid), installPaths(env).launchAgentPlist]
}

export function bootoutArgv(uid: number): string[] {
  return [LAUNCHCTL, 'bootout', `${guiDomain(uid)}/${LAUNCH_AGENT_LABEL}`]
}

export function printArgv(uid: number): string[] {
  return [LAUNCHCTL, 'print', `${guiDomain(uid)}/${LAUNCH_AGENT_LABEL}`]
}

/** The pre-rename agent (dev.shared-agent-memory.daemon); only the migration stops it. */
export function legacyPrintArgv(uid: number): string[] {
  return [LAUNCHCTL, 'print', `${guiDomain(uid)}/${LEGACY_LAUNCH_AGENT_LABEL}`]
}

export function legacyBootoutArgv(uid: number): string[] {
  return [LAUNCHCTL, 'bootout', `${guiDomain(uid)}/${LEGACY_LAUNCH_AGENT_LABEL}`]
}

/** `launchctl print` is read-only; exit 0 means launchd knows the service. */
export async function isAgentLoaded(env: InstallEnv, argv: readonly string[] = printArgv(env.uid)): Promise<boolean> {
  if (env.platform !== 'darwin') return false
  try {
    return (await env.run({ argv, timeoutMs: 5_000 })).exitCode === 0
  } catch {
    return false
  }
}
