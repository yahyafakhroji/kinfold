// Observer through the user's own `opencode` CLI and whatever providers they
// signed in to there. The run is `opencode run --standalone`, so it gets a
// private server rather than the user's background service (which loads their
// config and plugins, Kinfold's own plugin among them). That server sees:
//   - an empty config dir of our own, and project, Claude Code, update and
//     models-fetch loading turned off
//   - inline config defining one primary agent whose last permission rule
//     denies everything, plus policies denying tool use and MCP
// The system prompt lives in that inline config; the untrusted session text
// goes on stdin only. Every run is saved as a session in OpenCode's database,
// so cleanup deletes it by id, or by the run's unique title when no id came
// back. Facts follow docs/reference/observer-cli/opencode.md (opencode 2.1.4).

import { chmodSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { isRecord } from '../../contract/event'
import { ObserverError } from '../types'
import type { CliAdapter, CliParsed, CliRunContext, Semver } from './cli-core'
import type { SpawnFn, SpawnRequest, SpawnResult } from './claude-cli'

export const OPENCODE_MIN_VERSION: Semver = [2, 0, 0]
export const OBSERVER_AGENT = 'kinfold-observer'

const CONFIG_DIR = 'config'
const CONFIG_DIR_MODE = 0o700
const COMMAND_TIMEOUT_MS = 30_000
const VERSION_PATTERN = /\bv?(\d+)\.(\d+)\.(\d+)/
/** OpenCode substitutes these anywhere in config text. */
const SUBSTITUTIONS = ['{env:', '{file:'] as const
/** An id we pass back on argv: never empty, never flag-shaped. */
const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/

/** Types that are only model output or step markers. Every other type counts as a tool event. */
const OUTPUT_TYPES: ReadonlySet<string> = new Set(['text', 'reasoning', 'step_start', 'step_finish'])

const DENY_ALL = { action: '*', resource: '*', effect: 'deny' } as const
const POLICIES = [
  { action: 'tool.use', resource: '*', effect: 'deny' },
  { action: 'integration.use', resource: 'mcp:*', effect: 'deny' },
] as const

function configContent(system: string | null): string {
  const agent = { mode: 'primary', ...(system !== null ? { system } : {}), permissions: [DENY_ALL] }
  return JSON.stringify({
    default_agent: OBSERVER_AGENT,
    share: 'disabled',
    update: 'disable',
    snapshots: false,
    policies: POLICIES,
    agents: { [OBSERVER_AGENT]: agent },
  })
}

function envFor(runDir: string, baseEnv: Record<string, string>, system: string | null): Record<string, string> {
  return {
    ...baseEnv,
    OPENCODE_CONFIG_DIR: join(runDir, CONFIG_DIR),
    OPENCODE_DISABLE_PROJECT_CONFIG: '1',
    OPENCODE_DISABLE_CLAUDE_CODE: '1',
    OPENCODE_DISABLE_AUTOUPDATE: '1',
    OPENCODE_DISABLE_MODELS_FETCH: '1',
    OPENCODE_CONFIG_CONTENT: configContent(system),
  }
}

/** Without a system prompt: for listModels, and cleanup when no invocation was built. */
function isolatedEnv(runDir: string, baseEnv: Record<string, string>): Record<string, string> {
  return envFor(runDir, baseEnv, null)
}

/** The empty config dir OPENCODE_CONFIG_DIR names. Details carry the error code only, never the path. */
function makeConfigDir(runDir: string): void {
  const dir = join(runDir, CONFIG_DIR)
  try {
    mkdirSync(dir, { recursive: true, mode: CONFIG_DIR_MODE })
    chmodSync(dir, CONFIG_DIR_MODE)
  } catch (error: unknown) {
    throw new ObserverError('internal', `opencode config folder could not be made (${errorCode(error, 'mkdir failed')})`)
  }
}

function errorCode(error: unknown, fallback: string): string {
  return isRecord(error) && typeof error.code === 'string' ? error.code : fallback
}

function parseVersion(stdout: string): Semver | null {
  const match = VERSION_PATTERN.exec(stdout)
  if (match === null) return null
  const parts = [Number(match[1]), Number(match[2]), Number(match[3])] as const
  return parts.every(Number.isSafeInteger) ? parts : null
}

function invocation(input: { binaryPath: string; runDir: string; model: string; system: string; title: string; env: Record<string, string> }) {
  // A model like `--auto` would be read as a flag. Not quoted: settings text stays out of details.
  if (input.model === '' || input.model.startsWith('-')) throw new ObserverError('config_invalid', 'opencode model must not start with -')
  const env = envFor(input.runDir, input.env, input.system)
  // The system prompt is the only caller text in the config; check the whole text anyway.
  if (SUBSTITUTIONS.some((token) => env.OPENCODE_CONFIG_CONTENT!.includes(token))) {
    throw new ObserverError('internal', 'observer system prompt holds an OpenCode config substitution')
  }
  makeConfigDir(input.runDir)
  return {
    cmd: [input.binaryPath, 'run', '--standalone', '--agent', OBSERVER_AGENT, '--model', input.model, '--format', 'json', '--title', input.title],
    env,
    files: [],
  }
}

interface Scan {
  text: string
  sawText: boolean
  sessionId: string | null
  toolEvents: number
  malformedLines: number
  sawError: boolean
}

function scanEvents(stdout: string): Scan {
  const scan: Scan = { text: '', sawText: false, sessionId: null, toolEvents: 0, malformedLines: 0, sawError: false }
  for (const line of stdout.split('\n')) {
    if (line.trim() === '') continue
    let event: unknown
    try {
      event = JSON.parse(line)
    } catch {
      scan.malformedLines += 1
      continue
    }
    if (!isRecord(event)) {
      scan.malformedLines += 1
      continue
    }
    if (scan.sessionId === null && typeof event.sessionID === 'string' && SESSION_ID_PATTERN.test(event.sessionID)) scan.sessionId = event.sessionID
    const type = event.type
    if (type === 'error') {
      scan.sawError = true
    } else if (typeof type !== 'string' || !OUTPUT_TYPES.has(type)) {
      scan.toolEvents += 1
    } else if (type === 'text') {
      const part = isRecord(event.part) ? event.part : null
      if (part === null || typeof part.text !== 'string') scan.malformedLines += 1
      else {
        scan.text += part.text
        scan.sawText = true
      }
    }
  }
  return scan
}

/**
 * Tool events win over every other finding, so a failed or garbled run still
 * reports them to the core. Details are fixed strings and counts only.
 */
function parse(stdout: string): CliParsed {
  const scan = scanEvents(stdout)
  const base = { model: null, sessionId: scan.sessionId }
  if (scan.toolEvents > 0) return { ...base, text: scan.text, toolEvents: scan.toolEvents }
  if (scan.malformedLines > 0) throw new ObserverError('bad_response', `opencode output had ${scan.malformedLines} unreadable line(s)`)
  if (scan.sawError) throw new ObserverError('bad_response', 'opencode reported an error')
  if (!scan.sawText) throw new ObserverError('bad_response', 'opencode output has no text')
  return { ...base, text: scan.text, toolEvents: 0 }
}

/** Spawns one short opencode command; failures get fixed details. */
async function runCommand(spawn: SpawnFn, request: Omit<SpawnRequest, 'stdin' | 'timeoutMs'>, label: string): Promise<SpawnResult> {
  let result: SpawnResult
  try {
    result = await spawn({ ...request, stdin: '', timeoutMs: COMMAND_TIMEOUT_MS })
  } catch (error: unknown) {
    const code = errorCode(error, 'spawn failed')
    throw new ObserverError(code === 'ENOENT' ? 'cli_missing' : 'internal', `${label} could not start (${code})`)
  }
  if (result.timedOut) throw new ObserverError('timeout', `${label} did not finish in ${COMMAND_TIMEOUT_MS} ms`)
  if (result.exitCode !== 0) throw new ObserverError('exit_nonzero', `${label} exited ${result.exitCode}`)
  return result
}

/** Ids of sessions whose title is exactly `title`. Accepts a bare array or `{sessions: [...]}`. */
function sessionIdsTitled(stdout: string, title: string): string[] {
  let value: unknown
  try {
    value = JSON.parse(stdout)
  } catch {
    throw new ObserverError('bad_response', 'opencode session list output is not JSON')
  }
  const entries = Array.isArray(value) ? value : isRecord(value) && Array.isArray(value.sessions) ? value.sessions : null
  if (entries === null) throw new ObserverError('bad_response', 'opencode session list output has no session list')
  const ids: string[] = []
  for (const entry of entries) {
    if (!isRecord(entry) || entry.title !== title) continue
    if (typeof entry.id === 'string' && SESSION_ID_PATTERN.test(entry.id)) ids.push(entry.id)
  }
  return ids
}

async function deleteSession(ctx: CliRunContext, id: string): Promise<void> {
  await runCommand(ctx.spawn, { cmd: [ctx.binaryPath, 'session', 'delete', '--standalone', id], cwd: ctx.runDir, env: ctx.env }, 'opencode session delete')
}

/**
 * Deletes the run's saved session. Same env and cwd as the run, so the same
 * database and project. With no id (timeout, crash, garbled output) it deletes
 * only sessions whose title equals this run's random title. A run folder
 * without the config dir means `opencode run` was never built, so there is
 * nothing to delete.
 */
async function cleanup(ctx: CliRunContext): Promise<void> {
  if (ctx.sessionId !== null) return deleteSession(ctx, ctx.sessionId)
  if (!existsSync(join(ctx.runDir, CONFIG_DIR))) return
  const listed = await runCommand(
    ctx.spawn,
    { cmd: [ctx.binaryPath, 'session', 'list', '--standalone', '--format', 'json'], cwd: ctx.runDir, env: ctx.env },
    'opencode session list',
  )
  let firstError: unknown = null
  for (const id of sessionIdsTitled(listed.stdout, ctx.title)) {
    try {
      await deleteSession(ctx, id)
    } catch (error: unknown) {
      firstError ??= error
    }
  }
  if (firstError !== null) throw firstError
}

async function listModels(ctx: Omit<CliRunContext, 'title' | 'sessionId'>): Promise<string[]> {
  makeConfigDir(ctx.runDir)
  const result = await runCommand(ctx.spawn, { cmd: [ctx.binaryPath, 'models', '--standalone'], cwd: ctx.runDir, env: ctx.env }, 'opencode models')
  const models = result.stdout.split('\n').map((line) => line.trim()).filter((line) => line !== '')
  if (models.length === 0) throw new ObserverError('bad_response', 'opencode models output names no model')
  return models
}

export const opencodeAdapter: CliAdapter = {
  provider: 'opencode-cli',
  binary: 'opencode',
  extraEnv: ['XDG_DATA_HOME', 'OPENCODE_DB'],
  minVersion: OPENCODE_MIN_VERSION,
  parseVersion,
  isolatedEnv,
  invocation,
  parse,
  cleanup,
  listModels,
}
