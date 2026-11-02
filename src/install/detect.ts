// Which hosts live on this machine. Claude Code counts when `claude --version`
// answers or ~/.claude exists. OpenCode counts only when `opencode --version`
// reports 2.x or later (the plugin targets the V2 plugin contract), so a
// 1.x OpenCode is refused with a reason while the others still install.
// Codex counts when `codex --version` answers or Codex.app is installed;
// Cursor when `cursor-agent --version` or `cursor --version` answers or
// Cursor.app is installed. A ~/.codex or ~/.cursor directory alone does not
// count: other tools write there, so a leftover config is no sign of the host.
// `--hosts` replaces detection, but never admits a 1.x OpenCode.
// Each detection also names the file that pins its version (the resolved
// binary or the app's Info.plist), so host-versions.ts can tell an upgrade.

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { type InstallEnv, installPaths } from './env'

export const INSTALL_HOSTS = ['claude-code', 'opencode', 'codex', 'cursor'] as const
export type InstallHost = (typeof INSTALL_HOSTS)[number]

export const VERSION_TIMEOUT_MS = 5_000
const MIN_OPENCODE_MAJOR = 2
const WHICH = '/usr/bin/which'

export interface HostDetection {
  host: InstallHost
  /** True when this host gets wired. */
  selected: boolean
  version: string | null
  /** Why the host is or is not selected, for the install plan and status. */
  note: string
  /** The binary or Info.plist whose mtime pins `version`; null when unknown. */
  stampPath?: string | null
}

export type Semver = readonly [number, number, number]

/** "2.1.4", "v2.1.4" or "opencode v2.1.4". */
export function parseOpenCodeVersion(output: string): Semver | null {
  const match = /^\s*(?:opencode\s+)?v?(\d+)\.(\d+)\.(\d+)/im.exec(output)
  return match === null ? null : [Number(match[1]), Number(match[2]), Number(match[3])]
}

export type VersionAnswer =
  | { ok: true; stdout: string }
  | { ok: false; reason: 'not-found' | 'exit' | 'timeout' | 'error'; exitCode?: number }

const NOT_FOUND_EXIT = 127

/** What `<binary> --version` did, with the reason when it gave no output to read. */
export async function versionOf(env: InstallEnv, binary: string): Promise<VersionAnswer> {
  try {
    const result = await env.run({ argv: [binary, '--version'], timeoutMs: VERSION_TIMEOUT_MS })
    if (result.timedOut === true) return { ok: false, reason: 'timeout' }
    if (result.exitCode === NOT_FOUND_EXIT) return { ok: false, reason: 'not-found' }
    if (result.exitCode !== 0) return { ok: false, reason: 'exit', exitCode: result.exitCode }
    return { ok: true, stdout: result.stdout.trim() }
  } catch {
    return { ok: false, reason: 'error' }
  }
}

type Failed = Extract<VersionAnswer, { ok: false }>

/** The one-line reason for a failed `--version`; fixed text and the exit code only, never CLI output. */
function reasonNote(binary: string, answer: Failed): string {
  switch (answer.reason) {
    case 'not-found': return `no ${binary} on PATH`
    case 'exit': return `${binary} --version exited ${answer.exitCode ?? 'unknown'}`
    case 'timeout': return `${binary} --version timed out after ${VERSION_TIMEOUT_MS} ms`
    case 'error': return `${binary} --version could not be run`
  }
}

/** The absolute path `which` resolves, or null; install time only, never on a hook. */
export async function resolveBinary(env: InstallEnv, binary: string): Promise<string | null> {
  try {
    const result = await env.run({ argv: [WHICH, binary], timeoutMs: VERSION_TIMEOUT_MS })
    const path = result.stdout.trim().split('\n')[0] ?? ''
    return result.exitCode === 0 && path.startsWith('/') ? path : null
  } catch {
    return null
  }
}

export function applicationsDirs(env: Pick<InstallEnv, 'homeDir' | 'applicationsDirs'>): readonly string[] {
  return env.applicationsDirs ?? ['/Applications', join(env.homeDir, 'Applications')]
}

const BUNDLE_VERSION = /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/

/** An installed app bundle: its Info.plist and, when the plist is XML, its version. */
export function findApp(env: Pick<InstallEnv, 'homeDir' | 'applicationsDirs'>, bundle: string): { app: string; plist: string; version: string | null } | null {
  for (const dir of applicationsDirs(env)) {
    const app = join(dir, bundle)
    const plist = join(app, 'Contents', 'Info.plist')
    if (!existsSync(app)) continue
    let version: string | null = null
    try {
      version = BUNDLE_VERSION.exec(readFileSync(plist, 'utf8'))?.[1]?.trim() ?? null
    } catch {
      version = null
    }
    return { app, plist, version }
  }
  return null
}

async function detectClaudeCode(env: InstallEnv, forced: boolean): Promise<HostDetection> {
  const answer = await versionOf(env, 'claude')
  const hasDir = existsSync(installPaths(env).claudeDir)
  if (answer.ok) return { host: 'claude-code', selected: true, version: answer.stdout, note: 'claude --version answered', stampPath: await resolveBinary(env, 'claude') }
  if (hasDir) return { host: 'claude-code', selected: true, version: null, note: '~/.claude exists' }
  const missing = answer.reason === 'not-found'
  if (forced) return { host: 'claude-code', selected: true, version: null, note: `${missing ? 'not found' : reasonNote('claude', answer)}; wired because --hosts names it` }
  return { host: 'claude-code', selected: false, version: null, note: missing ? 'not found (no claude on PATH, no ~/.claude)' : reasonNote('claude', answer) }
}

async function detectOpenCode(env: InstallEnv, forced: boolean): Promise<HostDetection> {
  const answer = await versionOf(env, 'opencode')
  const parsed = answer.ok ? parseOpenCodeVersion(answer.stdout) : null
  const version = parsed === null ? null : parsed.join('.')
  if (parsed !== null && parsed[0] < MIN_OPENCODE_MAJOR) {
    return { host: 'opencode', selected: false, version, note: `OpenCode ${version} is not supported: the plugin needs OpenCode 2.0 or later` }
  }
  if (parsed !== null) return { host: 'opencode', selected: true, version, note: 'opencode --version answered 2.x or later', stampPath: await resolveBinary(env, 'opencode') }
  const reason = answer.ok ? 'opencode --version printed no version we could read' : answer.reason === 'not-found' ? 'not found (no opencode on PATH)' : reasonNote('opencode', answer)
  return forced
    ? { host: 'opencode', selected: true, version: null, note: `${reason}; wired because --hosts names it` }
    : { host: 'opencode', selected: false, version: null, note: reason }
}

interface CliHostSpec {
  host: 'codex' | 'cursor'
  binaries: readonly string[]
  bundle: string
}

const CODEX_SPEC: CliHostSpec = { host: 'codex', binaries: ['codex'], bundle: 'Codex.app' }
const CURSOR_SPEC: CliHostSpec = { host: 'cursor', binaries: ['cursor-agent', 'cursor'], bundle: 'Cursor.app' }

/** Codex and Cursor: the first binary that answers, else the app bundle. */
async function detectCliHost(env: InstallEnv, spec: CliHostSpec, forced: boolean): Promise<HostDetection> {
  const failures: string[] = []
  for (const binary of spec.binaries) {
    const answer = await versionOf(env, binary)
    if (!answer.ok) {
      if (answer.reason !== 'not-found') failures.push(reasonNote(binary, answer))
      continue
    }
    const version = answer.stdout.split('\n')[0]?.trim() || null
    return { host: spec.host, selected: true, version, note: `${binary} --version answered`, stampPath: await resolveBinary(env, binary) }
  }
  const app = findApp(env, spec.bundle)
  if (app !== null) return { host: spec.host, selected: true, version: app.version, note: `${app.app} exists`, stampPath: app.plist }
  const missing = failures.length > 0 ? failures.join('; ') : `not found (no ${spec.binaries.join(' or ')} on PATH, no ${spec.bundle})`
  return forced
    ? { host: spec.host, selected: true, version: null, note: `${missing}; wired because --hosts names it` }
    : { host: spec.host, selected: false, version: null, note: missing }
}

/** `override` is the --hosts list; null means detect. Order is INSTALL_HOSTS. */
export async function detectHosts(env: InstallEnv, override: readonly InstallHost[] | null): Promise<HostDetection[]> {
  const excluded = (host: InstallHost): HostDetection => ({ host, selected: false, version: null, note: 'left out by --hosts' })
  const forced = override !== null
  const detectors: Record<InstallHost, () => Promise<HostDetection>> = {
    'claude-code': () => detectClaudeCode(env, forced),
    opencode: () => detectOpenCode(env, forced),
    codex: () => detectCliHost(env, CODEX_SPEC, forced),
    cursor: () => detectCliHost(env, CURSOR_SPEC, forced),
  }
  const detections: HostDetection[] = []
  for (const host of INSTALL_HOSTS) {
    detections.push(override !== null && !override.includes(host) ? excluded(host) : await detectors[host]())
  }
  return detections
}

export function selectedHosts(detections: readonly HostDetection[]): InstallHost[] {
  return detections.filter((detection) => detection.selected).map((detection) => detection.host)
}
