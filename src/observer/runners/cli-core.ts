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
  /**
   * The env for anything that runs inside `runDir` outside `invocation`
   * (listModels, and cleanup when no invocation was built), such as a
   * redirected config dir. May return `baseEnv` unchanged.
   */
  isolatedEnv(runDir: string, baseEnv: Record<string, string>): Record<string, string>
  /**
   * Throws ObserverError('bad_response') on unreadable output. Also called on
   * failed runs to look for tool events. ObserverError details written here
   * must never quote CLI output.
   */
  parse(stdout: string): CliParsed
  /**
   * Removes anything the run left with the CLI (a saved session). Runs before
   * the run folder is removed; `env` is the env the invocation used. Errors
   * are logged by class only; details written here must never quote CLI output.
   */
  cleanup?(ctx: CliRunContext): Promise<void>
  /** Runs in its own run folder with `isolatedEnv`. Details written here must never quote CLI output. */
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
  /** Receives fixed, class-only lines, such as a cleanup failure. */
  log?: (line: string) => void
}

/** Under <dataDir>/observer/. */
export const RUNS_DIR = 'runs'
const PROBE_TIMEOUT_MS = 5_000
const TITLE_PREFIX = 'kinfold-observer-'
const TITLE_RANDOM_BYTES = 8
const PLANTED_FILE_MODE = 0o600

/** PATH and HOME to find the binary and its login; USER, LOGNAME and TMPDIR for keychain lookups; LANG for output encoding. */
const BASE_ENV = ['PATH', 'HOME', 'USER', 'LOGNAME', 'TMPDIR', 'LANG'] as const

/** Set last on every spawn env, so no adapter can drop or change them. */
function withObserverFlags(env: Readonly<Record<string, string>>): Record<string, string> {
  return { ...env, [OBSERVER_ENV_FLAG]: '1', [LEGACY_OBSERVER_ENV_FLAG]: '1' }
}

export function cliEnv(parent: Readonly<Record<string, string | undefined>>, extra: readonly string[]): Record<string, string> {
  const env: Record<string, string> = {}
  for (const key of [...BASE_ENV, ...extra]) {
    const value = parent[key]
    if (value !== undefined && value !== '') env[key] = value
  }
  // The legacy name is for old hook code during the migration; it goes when the SAM_* fallback goes.
  return withObserverFlags(env)
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
      throw new ObserverError('internal', `planted file could not be written (${errorCode(error, 'write failed')})`)
    }
  }
}

function errorCode(error: unknown, fallback: string): string {
  return isRecord(error) && typeof error.code === 'string' ? error.code : fallback
}

/** Spawns; a failure to start maps by code. */
async function spawnStarted(spawn: SpawnFn, request: SpawnRequest, label: string): Promise<SpawnResult> {
  try {
    return await spawn(request)
  } catch (error: unknown) {
    const code = errorCode(error, 'spawn failed')
    throw new ObserverError(code === 'ENOENT' ? 'cli_missing' : 'internal', `${label} could not start (${code})`)
  }
}

/** The class for a timed-out or failed run; stdout never reaches a detail. */
function exitFailure(result: SpawnResult, timeoutMs: number, label: string): ObserverError | null {
  if (result.timedOut) return new ObserverError('timeout', `${label} did not finish in ${timeoutMs} ms`)
  if (result.exitCode !== 0) return new ObserverError('exit_nonzero', `exited ${result.exitCode}`)
  return null
}

async function spawnChecked(spawn: SpawnFn, request: SpawnRequest, label: string): Promise<SpawnResult> {
  const result = await spawnStarted(spawn, request, label)
  const failure = exitFailure(result, request.timeoutMs, label)
  if (failure !== null) throw failure
  return result
}

/** Tool events in the output of a run that failed anyway; unreadable output counts as none. */
function toolEventsIn(adapter: CliAdapter, stdout: string): number {
  try {
    return adapter.parse(stdout).toolEvents
  } catch {
    return 0
  }
}

function toolAttempt(label: string, count: number): ObserverError {
  return new ObserverError('tool_attempt', `${label} output showed ${count} tool event(s)`)
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
async function inRunDir<T>(
  dataDir: string,
  body: (runDir: string) => Promise<T>,
  before: (runDir: string) => Promise<void>,
  onBeforeError: (error: ObserverError) => void,
): Promise<T> {
  let runDir: string
  try {
    runDir = makeRunDir(dataDir)
  } catch (error: unknown) {
    throw new ObserverError('internal', `run folder could not be made (${errorCode(error, 'mkdir failed')})`)
  }
  let outcome: { ok: true; value: T } | { ok: false; error: unknown }
  try {
    outcome = { ok: true, value: await body(runDir) }
  } catch (error: unknown) {
    outcome = { ok: false, error }
  }
  try {
    await before(runDir)
  } catch (error: unknown) {
    // A cleanup failure must never replace the run's result or error. Its
    // message could quote CLI output, so only the class is reported.
    onBeforeError(toObserverError(error))
  }
  const removed = removeRunDir(runDir)
  if (!outcome.ok) throw toObserverError(outcome.error)
  if (!removed) throw new ObserverError('internal', 'run folder could not be removed')
  return outcome.value
}

export function createCliObserverRunner(adapter: CliAdapter, options: CliRunnerOptions): CliObserverRunner {
  const rawSpawn = options.spawn ?? spawnProcess
  // Every spawn, the adapter's own included, gets the observer flags last.
  const spawn: SpawnFn = (request) => rawSpawn({ ...request, env: withObserverFlags(request.env) })
  const which = options.which ?? ((command: string, path: string) => Bun.which(command, { PATH: path }))
  const env = cliEnv(options.parentEnv ?? process.env, adapter.extraEnv)
  const label = adapter.provider
  const log = options.log ?? (() => {})
  const logCleanupFailure = (error: ObserverError): void => log(`${label} cleanup failed: ${error.errorClass}`)
  const isolated = (runDir: string): Record<string, string> => withObserverFlags(adapter.isolatedEnv(runDir, env))

  const probeChecked = async (): Promise<CliProbe> => {
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

  const probe = async (): Promise<CliProbe> => {
    try {
      return await probeChecked()
    } catch (error: unknown) {
      if (error instanceof ObserverError) throw error
      // An fs error's message holds a path, and a parseVersion error could quote output: keep the code only.
      throw new ObserverError('internal', `${label} probe failed (${errorCode(error, error instanceof Error ? error.name : 'unknown error')})`)
    }
  }

  const runWithFiles = async (prompt: ObserverPrompt, files: readonly PlantedFile[]): Promise<RunnerResult> => {
    // A probe failure throws here, before any run folder exists and before the
    // CLI was spawned for a run, so there is nothing for cleanup to remove.
    const { binaryPath } = await probe()
    const title = `${TITLE_PREFIX}${randomBytes(TITLE_RANDOM_BYTES).toString('hex')}`
    const timeoutMs = options.timeoutMs ?? DEFAULT_CLI_TIMEOUT_MS
    let sessionId: string | null = null
    let runEnv: Record<string, string> | null = null
    const body = async (runDir: string): Promise<RunnerResult> => {
      plantFiles(runDir, files)
      const invocation = adapter.invocation({ binaryPath, runDir, model: options.model, system: prompt.system, title, env })
      plantFiles(runDir, invocation.files)
      runEnv = withObserverFlags(invocation.env)
      const request: SpawnRequest = { cmd: invocation.cmd, cwd: runDir, env: runEnv, stdin: prompt.user, timeoutMs }
      const result = await spawnStarted(spawn, request, label)
      const failure = exitFailure(result, timeoutMs, label)
      if (failure !== null) {
        // The strictest tool rule wins over the exit class.
        const tools = toolEventsIn(adapter, result.stdout)
        throw tools > 0 ? toolAttempt(label, tools) : failure
      }
      const parsed = adapter.parse(result.stdout)
      sessionId = parsed.sessionId
      if (parsed.toolEvents > 0) throw toolAttempt(label, parsed.toolEvents)
      return { text: parsed.text, model: parsed.model ?? options.model }
    }
    const cleanup = async (runDir: string): Promise<void> => {
      if (adapter.cleanup === undefined) return
      await adapter.cleanup({ binaryPath, runDir, env: runEnv ?? isolated(runDir), title, sessionId, spawn })
    }
    return inRunDir(options.dataDir, body, cleanup, logCleanupFailure)
  }

  const listModels = async (): Promise<string[]> => {
    const { binaryPath } = await probe()
    return inRunDir(
      options.dataDir,
      (runDir) => adapter.listModels({ binaryPath, runDir, env: isolated(runDir), spawn }),
      async () => {},
      logCleanupFailure,
    )
  }

  return { run: (prompt) => runWithFiles(prompt, []), runWithFiles, probe, listModels }
}
