// Observer through the user's own `claude` CLI and Claude login (no API key).
// The child runs in print mode with every built-in tool off, no settings files
// (so no hooks or plugins), no MCP servers and no saved session, from a private
// directory under the data dir rather than any project. Its env is minimal and
// carries KINFOLD_OBSERVER=1, so our own hooks capture nothing if they run anyway.

import { chmodSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { isRecord } from '../../contract/event'
import { DATA_DIR_MODE } from '../../store/data-dir'
import { LEGACY_OBSERVER_ENV_FLAG, OBSERVER_ENV_FLAG } from '../env'
import { ObserverError, type ObserverPrompt, type ObserverRunner, type RunnerResult } from '../types'
import { withCmdShims } from './windows-shim'

export interface SpawnRequest {
  cmd: readonly string[]
  cwd: string
  env: Readonly<Record<string, string>>
  stdin: string
  timeoutMs: number
}

export interface SpawnResult {
  exitCode: number
  stdout: string
  timedOut: boolean
}

export type SpawnFn = (request: SpawnRequest) => Promise<SpawnResult>

export interface ClaudeCliOptions {
  dataDir: string
  model: string
  spawn?: SpawnFn
  /** Resolves the claude binary on the child's PATH; null means not installed. */
  which?: (command: string, path: string) => string | null
  parentEnv?: Readonly<Record<string, string | undefined>>
  timeoutMs?: number
}

export const OBSERVER_DIR = 'observer'
export const DEFAULT_CLI_TIMEOUT_MS = 180_000

/** PATH and HOME to find the binary and its login; USER, LOGNAME and TMPDIR for the macOS keychain lookup it does. */
const PASSED_ENV = ['PATH', 'HOME', 'USER', 'LOGNAME', 'TMPDIR', 'LANG', 'CLAUDE_CONFIG_DIR'] as const

export function observerEnv(parent: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const env: Record<string, string> = {}
  for (const key of PASSED_ENV) {
    const value = parent[key]
    if (value !== undefined && value !== '') env[key] = value
  }
  // The legacy name is for old hook code during the migration; it goes when the SAM_* fallback goes.
  return { ...env, [OBSERVER_ENV_FLAG]: '1', [LEGACY_OBSERVER_ENV_FLAG]: '1' }
}

export function claudeCliArgs(binary: string, model: string, systemPrompt: string): string[] {
  return [
    binary,
    '--print',
    '--model', model,
    '--output-format', 'json',
    '--tools', '',
    '--setting-sources', '',
    '--strict-mcp-config',
    '--no-session-persistence',
    '--disable-slash-commands',
    '--system-prompt', systemPrompt,
  ]
}

export function ensureObserverDir(dataDir: string): string {
  const dir = join(dataDir, OBSERVER_DIR)
  mkdirSync(dir, { recursive: true, mode: DATA_DIR_MODE })
  chmodSync(dir, DATA_DIR_MODE)
  return dir
}

export const spawnProcess: SpawnFn = async (request) => {
  const child = Bun.spawn([...request.cmd], {
    cwd: request.cwd,
    env: { ...request.env },
    stdin: new TextEncoder().encode(request.stdin),
    stdout: 'pipe',
    stderr: 'ignore',
  })
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    child.kill()
  }, request.timeoutMs)
  try {
    const [stdout, exitCode] = await Promise.all([new Response(child.stdout).text(), child.exited])
    return { exitCode, stdout, timedOut }
  } finally {
    clearTimeout(timer)
  }
}

function numberAt(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key]
  return typeof value === 'number' ? value : undefined
}

/** Reads `--output-format json`: one result object whose `result` holds the model's text. */
export function parseCliResult(stdout: string, configuredModel: string): RunnerResult {
  let value: unknown
  try {
    value = JSON.parse(stdout)
  } catch {
    throw new ObserverError('bad_response', 'claude output is not JSON')
  }
  if (!isRecord(value) || value.type !== 'result') throw new ObserverError('bad_response', 'claude output has no result object')
  if (value.is_error === true || value.subtype !== 'success') {
    throw new ObserverError('bad_response', `claude reported ${typeof value.subtype === 'string' ? value.subtype : 'an error'}`)
  }
  if (typeof value.result !== 'string') throw new ObserverError('bad_response', 'claude result is not text')
  const models = isRecord(value.modelUsage) ? Object.keys(value.modelUsage) : []
  const usage = isRecord(value.usage) ? value.usage : {}
  const inputTokens = numberAt(usage, 'input_tokens')
  const outputTokens = numberAt(usage, 'output_tokens')
  return {
    text: value.result,
    model: models[0] ?? configuredModel,
    usage: { ...(inputTokens !== undefined ? { inputTokens } : {}), ...(outputTokens !== undefined ? { outputTokens } : {}) },
  }
}

export function createClaudeCliRunner(options: ClaudeCliOptions): ObserverRunner {
  // An npm claude.cmd runs through its node script, never cmd.exe, so the system prompt is never parsed by a shell.
  const spawn = withCmdShims(options.spawn ?? spawnProcess)
  const which = options.which ?? ((command: string, path: string) => Bun.which(command, { PATH: path }))
  const env = observerEnv(options.parentEnv ?? process.env)

  const run = async (prompt: ObserverPrompt): Promise<RunnerResult> => {
    const binary = which('claude', env.PATH ?? '')
    if (binary === null) throw new ObserverError('cli_missing', 'claude not found on PATH')
    const request: SpawnRequest = {
      cmd: claudeCliArgs(binary, options.model, prompt.system),
      cwd: ensureObserverDir(options.dataDir),
      env,
      stdin: prompt.user,
      timeoutMs: options.timeoutMs ?? DEFAULT_CLI_TIMEOUT_MS,
    }
    let result: SpawnResult
    try {
      result = await spawn(request)
    } catch (error: unknown) {
      if (error instanceof ObserverError) throw error
      const code = isRecord(error) && typeof error.code === 'string' ? error.code : 'spawn failed'
      throw new ObserverError(code === 'ENOENT' ? 'cli_missing' : 'internal', `claude could not start (${code})`)
    }
    if (result.timedOut) throw new ObserverError('timeout', `claude did not finish in ${request.timeoutMs} ms`)
    if (result.exitCode !== 0) throw new ObserverError('exit_nonzero', `claude exited ${result.exitCode}`)
    return parseCliResult(result.stdout, options.model)
  }
  return { run }
}
