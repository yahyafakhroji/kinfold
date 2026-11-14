// How one agent is found on this machine: `--version` probes, app bundles, and
// the custom detectors for Claude Code and OpenCode. A leaf module: it never
// imports the profile table, so any profile can import it and be loaded first.

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AgentId, DetectionSpec } from '../agents/profile'
import { type InstallEnv, installPaths } from './env'

export const VERSION_TIMEOUT_MS = 5_000
const MIN_OPENCODE_MAJOR = 2
const WHICH = '/usr/bin/which'

export interface HostDetection {
  host: AgentId
  /** True when this host gets wired. */
  selected: boolean
  version: string | null
  /** Why the host is or is not selected, for the install plan and status. */
  note: string
  /** Not selected only because nothing was found, the same note for every such agent; install and status list these on one line. */
  absent?: boolean
  /** Not asked for: --hosts named other agents. Install lists these on one line. */
  leftOut?: boolean
  /** The binary or Info.plist whose mtime pins `version`; null when unknown. */
  stampPath?: string | null
}

/** Whether a host's detection line folds into the one `not found:` line: absent, and not wired anyway. */
export const isFoldedAbsent = (detection: HostDetection, wired: boolean): boolean => detection.absent === true && !detection.selected && !wired

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

export async function detectClaudeCode(env: InstallEnv, forced: boolean): Promise<HostDetection> {
  const answer = await versionOf(env, 'claude')
  const hasDir = existsSync(installPaths(env).claudeDir)
  if (answer.ok) return { host: 'claude-code', selected: true, version: answer.stdout, note: 'claude --version answered', stampPath: await resolveBinary(env, 'claude') }
  if (hasDir) return { host: 'claude-code', selected: true, version: null, note: '~/.claude exists' }
  const missing = answer.reason === 'not-found'
  if (forced) return { host: 'claude-code', selected: true, version: null, note: `${missing ? 'not found' : reasonNote('claude', answer)}; wired because --hosts names it` }
  return { host: 'claude-code', selected: false, version: null, note: missing ? 'not found (no claude on PATH, no ~/.claude)' : reasonNote('claude', answer), ...(missing ? { absent: true } : {}) }
}

export async function detectOpenCode(env: InstallEnv, forced: boolean): Promise<HostDetection> {
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
    : { host: 'opencode', selected: false, version: null, note: reason, ...(!answer.ok && answer.reason === 'not-found' ? { absent: true } : {}) }
}

/** pressly/goose, a database migration tool, answers `goose version: v3.x`; Block's Goose prints its bare version. */
const MIGRATION_GOOSE = /^goose version:/i

export async function detectGoose(env: InstallEnv, forced: boolean): Promise<HostDetection> {
  const answer = await versionOf(env, 'goose')
  if (answer.ok && !MIGRATION_GOOSE.test(answer.stdout)) {
    const version = answer.stdout.split('\n')[0]?.trim() || null
    return { host: 'goose', selected: true, version, note: 'goose --version answered', stampPath: await resolveBinary(env, 'goose') }
  }
  const reason = answer.ok
    ? 'goose on PATH is pressly/goose (database migrations), not Block\'s Goose'
    : answer.reason === 'not-found' ? 'not found (no goose on PATH)' : reasonNote('goose', answer)
  return forced ? { host: 'goose', selected: true, version: null, note: `${reason}; wired because --hosts names it` } : { host: 'goose', selected: false, version: null, note: reason, ...(!answer.ok && answer.reason === 'not-found' ? { absent: true } : {}) }
}

const ANY_SEMVER = /v?(\d+)\.(\d+)\.(\d+)/

function olderThan(version: Semver, min: Semver): boolean {
  for (let i = 0; i < 3; i++) {
    if (version[i] !== min[i]) return (version[i] ?? 0) < (min[i] ?? 0)
  }
  return false
}

/** A binary answer below the spec's minimum; --hosts never admits it, since the agent lacks what Kinfold wires. */
function tooOld(id: AgentId, binary: string, stdout: string, min: Semver | undefined): HostDetection | null {
  if (min === undefined) return null
  const match = ANY_SEMVER.exec(stdout)
  if (match === null) return null
  const version: Semver = [Number(match[1]), Number(match[2]), Number(match[3])]
  if (!olderThan(version, min)) return null
  return { host: id, selected: false, version: version.join('.'), note: `${binary} ${version.join('.')} is not supported: Kinfold needs ${min.join('.')} or later` }
}

/** The first binary that answers `--version`, else an app bundle. A config folder alone never counts: other tools write there. */
export async function detectFromSpec(env: InstallEnv, id: AgentId, spec: DetectionSpec, forced: boolean): Promise<HostDetection> {
  const failures: string[] = []
  for (const binary of spec.binaries) {
    const answer = await versionOf(env, binary)
    if (!answer.ok) {
      if (answer.reason !== 'not-found') failures.push(reasonNote(binary, answer))
      continue
    }
    const refused = tooOld(id, binary, answer.stdout, spec.minVersion)
    if (refused !== null) return refused
    const version = answer.stdout.split('\n')[0]?.trim() || null
    return { host: id, selected: true, version, note: `${binary} --version answered`, stampPath: await resolveBinary(env, binary) }
  }
  const bundles = spec.bundles ?? []
  for (const bundle of bundles) {
    const app = findApp(env, bundle)
    if (app !== null) return { host: id, selected: true, version: app.version, note: `${app.app} exists`, stampPath: app.plist }
  }
  const where = [`no ${spec.binaries.join(' or ')} on PATH`, ...(bundles.length > 0 ? [`no ${bundles.join(' or ')}`] : [])].join(', ')
  const missing = failures.length > 0 ? failures.join('; ') : `not found (${where})`
  return forced
    ? { host: id, selected: true, version: null, note: `${missing}; wired because --hosts names it` }
    : { host: id, selected: false, version: null, note: missing, ...(failures.length === 0 ? { absent: true } : {}) }
}

