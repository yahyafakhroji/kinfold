// Test doubles for the CLI observer core. Tests never run a real codex or
// opencode: they drive the core through a fake adapter and a spawn that
// records each request and answers from a script.

import { ObserverError } from '../types'
import type { CliAdapter, CliParsed, Semver } from './cli-core'
import type { SpawnFn, SpawnRequest, SpawnResult } from './claude-cli'

const VERSION_PATTERN = /(\d+)\.(\d+)\.(\d+)/

/** Reads `{"text":..,"model":..,"tools":..,"session":..}`; anything else is bad_response. */
function parseFakeOutput(stdout: string): CliParsed {
  let value: unknown
  try {
    value = JSON.parse(stdout)
  } catch {
    throw new ObserverError('bad_response', 'fake output is not JSON')
  }
  if (typeof value !== 'object' || value === null) throw new ObserverError('bad_response', 'fake output is not an object')
  const record = value as Record<string, unknown>
  if (typeof record.text !== 'string') throw new ObserverError('bad_response', 'fake output has no text')
  return {
    text: record.text,
    model: typeof record.model === 'string' ? record.model : null,
    toolEvents: typeof record.tools === 'number' ? record.tools : 0,
    sessionId: typeof record.session === 'string' ? record.session : null,
  }
}

export function fakeCliAdapter(overrides: Partial<CliAdapter> = {}): CliAdapter {
  return {
    provider: 'codex-cli',
    binary: 'fakecli',
    extraEnv: ['FAKE_CLI_HOME'],
    minVersion: [1, 0, 0],
    parseVersion: (stdout: string): Semver | null => {
      const match = VERSION_PATTERN.exec(stdout)
      return match === null ? null : [Number(match[1]), Number(match[2]), Number(match[3])]
    },
    invocation: ({ binaryPath, model, env }) => ({ cmd: [binaryPath, 'run', '--model', model], env, files: [] }),
    parse: parseFakeOutput,
    listModels: async () => ['fake/model'],
    ...overrides,
  }
}

/** Answers each spawn with the next entry (defaults: exit 0, empty stdout, no timeout); runs out → throws. */
export function recordingSpawn(answers: Array<Partial<SpawnResult>>): SpawnFn & { requests: SpawnRequest[] } {
  const requests: SpawnRequest[] = []
  const spawn = async (request: SpawnRequest): Promise<SpawnResult> => {
    const answer = answers[requests.length]
    requests.push(request)
    if (answer === undefined) throw new Error('recordingSpawn has no answer left')
    return { exitCode: 0, stdout: '', timedOut: false, ...answer }
  }
  return Object.assign(spawn, { requests })
}
