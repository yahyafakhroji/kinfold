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

test('the prompt says the list is unavailable when listing fails, and still takes a typed name', async () => {
  world = createWorld({ interactive: true, answers: ['opencode-cli', 'typed/name'], cliRunner: () => cli({ listModels: async () => { throw new ObserverError('cli_missing', 'secret path /x') } }) })
  const [choice] = await chooseObservers(world.env, ['opencode'], { ...options, skipCheck: true })
  expect(choice?.input).toMatchObject({ provider: 'opencode-cli', model: 'typed/name' })
  expect(world.out).toContain('model list unavailable (cli_missing); type a model name')
  expect(world.out.join('\n')).not.toContain('/x')
})
