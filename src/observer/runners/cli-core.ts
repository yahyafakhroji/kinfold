// The shared core for observers that borrow a user's CLI login (Codex,
// OpenCode). It is the safety boundary: the observer reads untrusted session
// text, so every run goes through the same checks here, whatever the adapter.
//   - The child gets a stripped env plus the observer flags, so our own hooks
//     and plugins capture nothing.
//   - Each run gets a new private folder under <dataDir>/observer/runs/, which
//     is removed afterwards in every case, after the adapter's own cleanup.
//   - Any tool event in the output rejects the whole run (tool_attempt). There
//     is no allow list.
//   - Error details are written here. They never quote stdout, stdin, prompt
//     text, env values or file contents.

import { randomBytes } from 'node:crypto'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { isRecord } from '../../contract/event'
import { DATA_DIR_MODE } from '../../store/data-dir'
import { LEGACY_OBSERVER_ENV_FLAG, OBSERVER_ENV_FLAG } from '../env'
import {
  type CliLoginProvider,
  ObserverError,
  type ObserverPrompt,
  type ObserverRunner,
  type RunnerResult,
  toObserverError,
} from '../types'
import { DEFAULT_CLI_TIMEOUT_MS, type SpawnFn, type SpawnRequest, type SpawnResult, ensureObserverDir, spawnProcess } from './claude-cli'

export type Semver = readonly [number, number, number]
export interface CliProbe { version: string; binaryPath: string }
export interface PlantedFile { name: string; content: string }
/** `files` are written into runDir before spawn. */
export interface CliInvocation { cmd: string[]; env: Record<string, string>; files: PlantedFile[] }
export interface CliParsed { text: string; model: string | null; toolEvents: number; sessionId: string | null }
export interface CliRunContext { binaryPath: string; runDir: string; env: Record<string, string>; title: string; sessionId: string | null; spawn: SpawnFn }

export interface CliAdapter {
  provider: CliLoginProvider
  binary: string
  extraEnv: readonly string[]
  minVersion: Semver
  parseVersion(stdout: string): Semver | null
  invocation(input: { binaryPath: string; runDir: string; model: string; system: string; title: string; env: Record<string, string> }): CliInvocation
  /** Throws ObserverError('bad_response') on unreadable output. */
  parse(stdout: string): CliParsed
  cleanup?(ctx: CliRunContext): Promise<void>
  listModels(ctx: Omit<CliRunContext, 'title' | 'sessionId'>): Promise<string[]>
}

export interface CliObserverRunner extends ObserverRunner {
  probe(): Promise<CliProbe>
  runWithFiles(prompt: ObserverPrompt, files: readonly PlantedFile[]): Promise<RunnerResult>
  listModels(): Promise<string[]>
}

export interface CliRunnerOptions {
  dataDir: string
  model: string
  spawn?: SpawnFn
  /** Resolves the binary on the child's PATH; null means not installed. */
  which?: (command: string, path: string) => string | null
  parentEnv?: Readonly<Record<string, string | undefined>>
  timeoutMs?: number
}

/** Under <dataDir>/observer/. */
export const RUNS_DIR = 'runs'
const PROBE_TIMEOUT_MS = 5_000
const TITLE_PREFIX = 'kinfold-observer-'
const TITLE_RANDOM_BYTES = 8
const PLANTED_FILE_MODE = 0o600

/** PATH and HOME to find the binary and its login; USER, LOGNAME and TMPDIR for keychain lookups; LANG for output encoding. */
const BASE_ENV = ['PATH', 'HOME', 'USER', 'LOGNAME', 'TMPDIR', 'LANG'] as const

export function cliEnv(parent: Readonly<Record<string, string | undefined>>, extra: readonly string[]): Record<string, string> {
  const env: Record<string, string> = {}
  for (const key of [...BASE_ENV, ...extra]) {
    const value = parent[key]
    if (value !== undefined && value !== '') env[key] = value
  }
  // The legacy name is for old hook code during the migration; it goes when the SAM_* fallback goes.
  return { ...env, [OBSERVER_ENV_FLAG]: '1', [LEGACY_OBSERVER_ENV_FLAG]: '1' }
}

function formatSemver(version: Semver): string {
  return version.join('.')
}

function isBelow(version: Semver, min: Semver): boolean {
  for (let i = 0; i < 3; i += 1) {
    if (version[i]! !== min[i]!) return version[i]! < min[i]!
  }
  return false
}

/** A plain file name: not empty, not `.`, and no `/`, `\`, `..` or NUL. */
function isPlainFileName(name: string): boolean {
  return name !== '' && name !== '.' && !name.includes('/') && !name.includes('\\') && !name.includes('..') && !name.includes('\0')
}

function plantFiles(runDir: string, files: readonly PlantedFile[]): void {
  for (const file of files) {
    // The name is never quoted: the detail must not carry caller text.
    if (!isPlainFileName(file.name)) throw new ObserverError('internal', 'planted file name is not a plain file name')
  }
  for (const file of files) {
    try {
      writeFileSync(join(runDir, file.name), file.content, { mode: PLANTED_FILE_MODE, flag: 'wx' })
    } catch (error: unknown) {
      const code = isRecord(error) && typeof error.code === 'string' ? error.code : 'write failed'
      throw new ObserverError('internal', `planted file could not be written (${code})`)
    }
  }
}

/** Spawns and maps every failure to a class; stdout never reaches a detail. */
async function spawnChecked(spawn: SpawnFn, request: SpawnRequest, label: string): Promise<SpawnResult> {
  let result: SpawnResult
  try {
    result = await spawn(request)
  } catch (error: unknown) {
    const code = isRecord(error) && typeof error.code === 'string' ? error.code : 'spawn failed'
    throw new ObserverError(code === 'ENOENT' ? 'cli_missing' : 'internal', `${label} could not start (${code})`)
  }
  if (result.timedOut) throw new ObserverError('timeout', `${label} did not finish in ${request.timeoutMs} ms`)
  if (result.exitCode !== 0) throw new ObserverError('exit_nonzero', `exited ${result.exitCode}`)
  return result
}

function makeRunDir(dataDir: string): string {
  const root = join(ensureObserverDir(dataDir), RUNS_DIR)
  mkdirSync(root, { recursive: true, mode: DATA_DIR_MODE })
  chmodSync(root, DATA_DIR_MODE)
  const runDir = mkdtempSync(join(root, 'run-'))
  chmodSync(runDir, DATA_DIR_MODE)
  return runDir
}

/** True when the folder is gone. */
function removeRunDir(runDir: string): boolean {
  try {
    rmSync(runDir, { recursive: true, force: true, maxRetries: 3 })
    return true
  } catch {
    return false
  }
}

/**
 * Runs `body` in a new run folder, then `before` (the adapter's cleanup, whose
 * errors are dropped), then removes the folder. The body's own error always
 * wins; a folder that could not be removed fails an otherwise good run.
 */
async function inRunDir<T>(dataDir: string, body: (runDir: string) => Promise<T>, before: (runDir: string) => Promise<void>): Promise<T> {
  let runDir: string
  try {
    runDir = makeRunDir(dataDir)
  } catch (error: unknown) {
    const code = isRecord(error) && typeof error.code === 'string' ? error.code : 'mkdir failed'
    throw new ObserverError('internal', `run folder could not be made (${code})`)
  }
  let outcome: { ok: true; value: T } | { ok: false; error: unknown }
  try {
    outcome = { ok: true, value: await body(runDir) }
  } catch (error: unknown) {
    outcome = { ok: false, error }
  }
  try {
    await before(runDir)
  } catch {
    // A cleanup failure must never replace the run's result or error, and its
    // message could quote CLI output, so it is not kept.
  }
  const removed = removeRunDir(runDir)
  if (!outcome.ok) throw toObserverError(outcome.error)
  if (!removed) throw new ObserverError('internal', 'run folder could not be removed')
  return outcome.value
}

export function createCliObserverRunner(adapter: CliAdapter, options: CliRunnerOptions): CliObserverRunner {
  const spawn = options.spawn ?? spawnProcess
  const which = options.which ?? ((command: string, path: string) => Bun.which(command, { PATH: path }))
  const env = cliEnv(options.parentEnv ?? process.env, adapter.extraEnv)
  const label = adapter.provider

  const probe = async (): Promise<CliProbe> => {
    const binaryPath = which(adapter.binary, env.PATH ?? '')
    if (binaryPath === null) throw new ObserverError('cli_missing', `${adapter.binary} not found on PATH`)
    const result = await spawnChecked(
      spawn,
      { cmd: [binaryPath, '--version'], cwd: ensureObserverDir(options.dataDir), env, stdin: '', timeoutMs: PROBE_TIMEOUT_MS },
      `${label} --version`,
    )
    const version = adapter.parseVersion(result.stdout)
    if (version === null) throw new ObserverError('bad_response', `${label} --version output has no version`)
    if (isBelow(version, adapter.minVersion)) {
      throw new ObserverError('config_invalid', `${label} is older than the minimum version ${formatSemver(adapter.minVersion)}`)
    }
    return { version: formatSemver(version), binaryPath }
  }

  const runWithFiles = async (prompt: ObserverPrompt, files: readonly PlantedFile[]): Promise<RunnerResult> => {
    const { binaryPath } = await probe()
    const title = `${TITLE_PREFIX}${randomBytes(TITLE_RANDOM_BYTES).toString('hex')}`
    let sessionId: string | null = null
    const body = async (runDir: string): Promise<RunnerResult> => {
      plantFiles(runDir, files)
      const invocation = adapter.invocation({ binaryPath, runDir, model: options.model, system: prompt.system, title, env })
      plantFiles(runDir, invocation.files)
      const request: SpawnRequest = {
        cmd: invocation.cmd,
        cwd: runDir,
        env: invocation.env,
        stdin: prompt.user,
        timeoutMs: options.timeoutMs ?? DEFAULT_CLI_TIMEOUT_MS,
      }
      const result = await spawnChecked(spawn, request, label)
      const parsed = adapter.parse(result.stdout)
      sessionId = parsed.sessionId
      if (parsed.toolEvents > 0) throw new ObserverError('tool_attempt', `${label} output showed ${parsed.toolEvents} tool event(s)`)
      return { text: parsed.text, model: parsed.model ?? options.model }
    }
    const cleanup = async (runDir: string): Promise<void> => {
      if (adapter.cleanup === undefined) return
      await adapter.cleanup({ binaryPath, runDir, env, title, sessionId, spawn })
    }
    return inRunDir(options.dataDir, body, cleanup)
  }

  const listModels = async (): Promise<string[]> => {
    const { binaryPath } = await probe()
    return inRunDir(options.dataDir, (runDir) => adapter.listModels({ binaryPath, runDir, env, spawn }), async () => {})
  }

  return { run: (prompt) => runWithFiles(prompt, []), runWithFiles, probe, listModels }
}
