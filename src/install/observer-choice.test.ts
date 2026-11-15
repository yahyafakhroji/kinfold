import { expect, test } from 'bun:test'
import { parseProviderModel, settingsInputFor } from './observer-choice'

test('settingsInputFor gives a CLI-login provider no credential ref', () => {
  expect(settingsInputFor('codex', 'codex-cli', 'gpt-x').credentialRef).toBeNull()
  expect(settingsInputFor('codex', 'openrouter', 'm').credentialRef).toBe('openrouter')
})

test('parseProviderModel keeps the slash in the model and splits only on the first colon', () => {
  expect(parseProviderModel('opencode-cli:anthropic/claude-x')).toEqual({ provider: 'opencode-cli', model: 'anthropic/claude-x' })
})

import { afterEach } from 'bun:test'
import type { CliObserverRunner } from '../observer/runners/cli-core'
import { ObserverError } from '../observer/types'
import { ChoiceError, chooseObservers, describeInput, runCheck } from './observer-choice'
import { type FakeWorld, createWorld } from './test-support'

let world: FakeWorld | null = null
afterEach(async () => {
  await world?.cleanup()
  world = null
})

const noCredentials = { get: () => null }
const options = { yes: false, dryRun: false, skipCheck: false, replaceCredential: false, credentialStdin: false, flags: [] } as const

function cli(parts: Partial<CliObserverRunner> & { calls?: string[] } = {}): CliObserverRunner {
  const calls = parts.calls ?? []
  return {
    run: parts.run ?? (async () => (calls.push('run'), { text: 'OK', model: 'm' })),
    runWithFiles: parts.runWithFiles ?? (async () => (calls.push('planted'), { text: 'nothing', model: 'm' })),
    probe: async () => ({ version: '1', binaryPath: '/x' }),
    listModels: parts.listModels ?? (async () => []),
  }
}

test('runCheck runs the OK check then the planted test for a CLI provider', async () => {
  const calls: string[] = []
  world = createWorld({ cliRunner: () => cli({ calls }) })
  const input = { host: 'codex', provider: 'codex-cli', model: 'gpt-x', credentialRef: null, enabled: true } as const
  expect(await runCheck(world.env, input, noCredentials)).toEqual({ ok: true })
  expect(calls).toEqual(['run', 'planted'])
})

test('runCheck reports a planted failure by class', async () => {
  world = createWorld({ cliRunner: () => cli({ runWithFiles: async () => { throw new ObserverError('tool_attempt', 'x') } }) })
  const input = { host: 'codex', provider: 'opencode-cli', model: 'm', credentialRef: null, enabled: true } as const
  expect(await runCheck(world.env, input, noCredentials)).toEqual({ ok: false, errorClass: 'tool_attempt' })
  world.env.cliRunnerFor = () => cli({ runWithFiles: async (prompt, files) => ({ text: files[0]?.content ?? '', model: 'm' }) })
  expect(await runCheck(world.env, input, noCredentials)).toEqual({ ok: false, errorClass: 'safety_check_failed' })
})

test('--yes ends the install on a planted failure; skip-check runs neither check', async () => {
  world = createWorld({ cliRunner: () => cli({ runWithFiles: async () => { throw new ObserverError('tool_attempt', 'x') } }) })
  const flags = [{ host: 'codex', provider: 'codex-cli', model: 'gpt-x' }] as const
  await expect(chooseObservers(world.env, ['codex'], { ...options, yes: true, flags })).rejects.toThrow(new ChoiceError('observer check for codex failed: tool_attempt'))
  world.checks.length = 0
  const [choice] = await chooseObservers(world.env, ['codex'], { ...options, yes: true, skipCheck: true, flags })
  expect(choice?.check).toBe('skipped')
  expect(choice?.credentialNote).toBe('no key needed')
  expect(world.checks).toEqual([])
  expect(describeInput(choice!.input)).toBe('codex-cli/gpt-x')
})

test('the prompt lists at most 20 models for a CLI provider and accepts a typed name', async () => {
  const names = Array.from({ length: 25 }, (_, index) => `model-${index + 1}`)
  world = createWorld({ interactive: true, answers: ['codex-cli', 'model-3'], cliRunner: () => cli({ listModels: async () => names }) })
  const [choice] = await chooseObservers(world.env, ['codex'], { ...options, skipCheck: true })
  expect(choice?.input).toMatchObject({ provider: 'codex-cli', model: 'model-3' })
  expect(world.out.filter((line) => /^\s*model-\d+$/.test(line))).toHaveLength(20)
  expect(world.out).not.toContain('  model-21')
})

test('the model list drops names holding control or format characters (bidi overrides, zero-width)', async () => {
  const names = ['good-model', 'bad\u001b[31m', 'rtl\u202Eevil', 'zero\u200Bwidth', 'bom\uFEFF', 'also-good']
  world = createWorld({ interactive: true, answers: ['codex-cli', 'good-model'], cliRunner: () => cli({ listModels: async () => names }) })
  await chooseObservers(world.env, ['codex'], { ...options, skipCheck: true })
  const listed = world.out.filter((line) => line.startsWith('  '))
  expect(listed).toEqual(['  good-model', '  also-good'])
  expect(world.out).toContain('codex-cli models (first 2):')
})

test('the prompt says the list is unavailable when listing fails, and still takes a typed name', async () => {
  world = createWorld({ interactive: true, answers: ['opencode-cli', 'typed/name'], cliRunner: () => cli({ listModels: async () => { throw new ObserverError('cli_missing', 'secret path /x') } }) })
  const [choice] = await chooseObservers(world.env, ['opencode'], { ...options, skipCheck: true })
  expect(choice?.input).toMatchObject({ provider: 'opencode-cli', model: 'typed/name' })
  expect(world.out).toContain('model list unavailable (cli_missing); type a model name')
  expect(world.out.join('\n')).not.toContain('/x')
})

/** Records each question the plain prompt asks. */
function recordingAsk(w: FakeWorld): string[] {
  const asked: string[] = []
  const ask = w.env.io.ask
  w.env.io.ask = async (question) => (asked.push(question), ask(question))
  return asked
}

const CODEX_MISSING = async () => new Map([['codex-cli', 'codex not installed']] as const)

test('the plain prompt marks a provider whose CLI is missing and refuses it when typed', async () => {
  world = createWorld({ interactive: true, answers: ['codex-cli:gpt-x', 'codex-cli', 'opencode-cli:m'] })
  const asked = recordingAsk(world)
  const [choice] = await chooseObservers(world.env, ['claude-code'], { ...options, skipCheck: true, missingClis: CODEX_MISSING })
  expect(choice?.input).toMatchObject({ provider: 'opencode-cli', model: 'm' })
  expect(asked[0]).toContain('Providers: claude-cli, openrouter, codex-cli (codex not installed), opencode-cli.')
  expect(asked[0]).toContain('a bare opencode-cli lists')
  expect(asked[0]).not.toContain('a bare codex-cli')
  expect(world.out.filter((line) => line === 'codex-cli cannot be picked: codex not installed')).toHaveLength(2)
})

test('the plain prompt does not keep a default whose CLI is missing', async () => {
  world = createWorld({ interactive: true, answers: ['', 'openrouter:some/model'], keychainRefs: ['openrouter'] })
  const asked = recordingAsk(world)
  const claudeMissing = async () => new Map([['claude-cli', 'claude not installed']] as const)
  const [choice] = await chooseObservers(world.env, ['claude-code'], { ...options, skipCheck: true, missingClis: claudeMissing })
  expect(choice?.input).toMatchObject({ provider: 'openrouter', model: 'some/model' })
  expect(asked[0]).toContain('default claude-cli/haiku (claude not installed; pick another). Providers: claude-cli (claude not installed), openrouter,')
  expect(asked[0]).not.toContain('Press Enter to keep the default')
  expect(world.out).toContain('claude not installed; pick another')
})

test('with every CLI found the plain prompt reads as it always did', async () => {
  world = createWorld({ interactive: true, answers: [''] })
  const asked = recordingAsk(world)
  const [choice] = await chooseObservers(world.env, ['claude-code'], { ...options, skipCheck: true, missingClis: async () => new Map() })
  expect(choice?.origin).toBe('default')
  expect(asked[0]).toBe(
    'Observer for claude-code: default claude-cli/haiku. Providers: claude-cli, openrouter, codex-cli, opencode-cli.\n' +
      "Press Enter to keep the default, or type provider:model (a bare codex-cli or opencode-cli lists that CLI's models) > ",
  )
})
