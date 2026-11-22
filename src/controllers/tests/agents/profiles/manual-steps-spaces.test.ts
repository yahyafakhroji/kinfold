// A data folder with a space in it ("Application Support" on macOS) is one
// argument to the hook and the MCP server. Each agent's by-hand step prints
// that argument in its own format (JSON, a YAML flow mapping, a crushrc word),
// and each must read back as exactly what install writes.

import { afterEach, beforeEach, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { entryCommand } from '../../install/entry'
import type { InstallEnv } from '../../install/env'
import { MCP_SERVER_NAME } from '../../install/mcp-config'
import { MCP_HOST_ENV } from '../../mcp/read-reporter'
import type { JsonAgentFile } from '../families/json-agent'
import { hookTarget, shellCommand } from '../families/json-hooks'
import type { AgentId } from '../profile'
import { AMP_MCP_FILE } from './amp'
import { CLINE_MCP_FILE } from './cline'
import { CRUSH_MCP_FILE } from './crush'
import { type HookBench, apply, hookBench, profile } from './custom-hooks.test-support'
import { gooseHooksPath } from './goose'
import { KILO_MCP_FILE } from './kilo-code'

let bench: HookBench
beforeEach(() => {
  bench = hookBench()
})
afterEach(async () => {
  await bench.cleanup()
})

function spacedEnv(): InstallEnv {
  const w = bench.world()
  return { ...w.env, dataDir: join(w.root, 'Application Support', 'kinfold') }
}

const stepsOf = (id: AgentId, env: InstallEnv): string => profile(id).manualSteps('macos', env).join('\n')

/** The JSON object that follows `"kinfold": ` in a step, whatever text comes after it. */
function entryInStep(step: string): unknown {
  const start = step.indexOf('{', step.indexOf(`"${MCP_SERVER_NAME}": `))
  let depth = 0
  let inString = false
  for (let at = start; at < step.length; at += 1) {
    const char = step[at]
    if (inString) {
      if (char === '\\') at += 1
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') inString = true
    if (char === '{') depth += 1
    if (char === '}') depth -= 1
    if (depth === 0) return JSON.parse(step.slice(start, at + 1))
  }
  throw new Error('no MCP entry in the step')
}

async function installedEntry(id: AgentId, file: JsonAgentFile, env: InstallEnv): Promise<unknown> {
  apply(await profile(id).wiring.install(env))
  const config = JSON.parse(readFileSync(file.path(env), 'utf8')) as Record<string, Record<string, unknown>>
  return config[file.mcp?.key ?? '']?.[MCP_SERVER_NAME]
}

/** Every argument of an entry, whichever of the two shapes it has: command + args, or one command array. */
function wordsOf(entry: unknown): unknown[] {
  const { command, args } = entry as { command: unknown; args?: unknown[] }
  return Array.isArray(command) ? command : [command, ...(args ?? [])]
}

test.each([
  ['kilo-code', KILO_MCP_FILE],
  ['amp', AMP_MCP_FILE],
  ['cline', CLINE_MCP_FILE],
] as const)('%s: with a space in the data folder, the JSON entry in the manual step is the one install writes', async (id, file) => {
  const env = spacedEnv()
  const printed = entryInStep(stepsOf(id, env))
  expect(printed).toEqual(await installedEntry(id, file, env))
  expect(wordsOf(printed)).toContain(env.dataDir)
})

/** The words of a crushrc line as Bash reads them: double-quoted words unescaped, bare words as they are. */
function bashWords(line: string): string[] {
  return [...line.matchAll(/"((?:[^"\\]|\\.)*)"|(\S+)/g)].map((match) => (match[1] !== undefined ? match[1].replace(/\\([\\"$`])/g, '$1') : (match[2] ?? '')))
}

const flagValues = (words: readonly string[], flag: string): string[] => words.flatMap((word, at) => (word === flag ? [words[at + 1] ?? ''] : []))

test('crush: with a space in the data folder, the crushrc lines read back as the command and args install writes', async () => {
  const env = spacedEnv()
  const lines = stepsOf('crush', env).split('\n')
  const installed = (await installedEntry('crush', CRUSH_MCP_FILE, env)) as { command: string; args: string[]; env: Record<string, string> }

  const mcp = bashWords(lines.find((line) => line.trimStart().startsWith('mcp add ')) ?? '')
  expect(flagValues(mcp, '--command')).toEqual([installed.command])
  expect(flagValues(mcp, '--args')).toEqual(installed.args)
  expect(installed.args).toContain(env.dataDir)
  expect(mcp.slice(-3)).toEqual(['--env', MCP_HOST_ENV, installed.env[MCP_HOST_ENV] ?? ''])

  // The hook command is one crushrc word, and that word is the shell command a hooks file would carry.
  const hook = bashWords(lines.find((line) => line.trimStart().startsWith('hook add PostToolUse ')) ?? '')
  expect(flagValues(hook, '--command')).toEqual([shellCommand(hookTarget(env, 'crush').entry)])
  expect(hook.slice(-2)).toEqual(['--timeout', '10'])
})

test('goose: with a space in the data folder, the YAML step carries the MCP command and args whole, and hooks.json the quoted hook command', async () => {
  const env = spacedEnv()
  const step = stepsOf('goose', env)
  const entry = entryCommand(env.mode, 'mcp', env.dataDir)
  // JSON strings are YAML double-quoted scalars, so reading them as JSON is reading them as YAML does.
  const cmd = /cmd: ("(?:[^"\\]|\\.)*")/.exec(step)?.[1] ?? 'null'
  const args = /args: (\[.*\]), envs:/.exec(step)?.[1] ?? 'null'
  expect(JSON.parse(cmd)).toBe(entry.command)
  expect(JSON.parse(args)).toEqual(entry.args)
  expect(entry.args).toContain(env.dataDir)

  apply(await profile('goose').wiring.install(env))
  const hooks = JSON.parse(readFileSync(gooseHooksPath(env), 'utf8')) as { hooks: Record<string, { hooks: { command: string }[] }[]> }
  expect(hooks.hooks.PostToolUse?.[0]?.hooks[0]?.command).toBe(shellCommand(hookTarget(env, 'goose').entry))
})
