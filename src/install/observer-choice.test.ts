import { expect, test } from 'bun:test'
import { LOCAL_ENDPOINT, defaultEndpoint, parseProviderModel, settingsInputFor } from './observer-choice'


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
import { CLAUDE_TOKEN_REF } from '../observer/settings'
import { parseObserverFlag } from './args'
import { NO_TOOLS_OFF } from '../agents/profile'
import { UNPROVEN_CLI_PROVIDERS } from '../observer/types'
import { INSTALL_PROFILES } from '../agents/install-profiles'
import { ChoiceError, chooseObservers, describeInput, runCheck, selfObserverNote, withObserverEndpoint } from './observer-choice'
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
  expect(asked[0]).toContain('Providers: claude-cli, openrouter, codex-cli (codex not installed), opencode-cli, goose-cli, anthropic-api,')
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

test('with every CLI found the plain prompt lists every provider, and auggie-cli with why it cannot be picked', async () => {
  world = createWorld({ interactive: true, answers: [''] })
  const asked = recordingAsk(world)
  const [choice] = await chooseObservers(world.env, ['claude-code'], { ...options, skipCheck: true, missingClis: async () => new Map() })
  expect(choice?.origin).toBe('default')
  expect(asked[0]).toBe(
    'Observer for claude-code: default claude-cli/haiku. Providers: claude-cli, openrouter, codex-cli, opencode-cli, goose-cli, anthropic-api, openai-api, gemini-api, qwen-api, openai-compatible, ' +
      `auggie-cli (${UNPROVEN_CLI_PROVIDERS['auggie-cli']}).\n` +
      "Press Enter to keep the default, or type provider:model (a bare codex-cli or opencode-cli lists that CLI's models), or off (capture only, no summaries) > ",
  )
})

// ---- off: capture only ---------------------------------------------------------

test('the plain prompt takes "off": capture only, with no key asked and no model call', async () => {
  const calls: string[] = []
  world = createWorld({ interactive: true, answers: ['off'], cliRunner: () => cli({ calls }) })
  const asked = recordingAsk(world)
  const [choice] = await chooseObservers(world.env, ['claude-code'], { ...options, missingClis: async () => new Map() })
  expect(choice?.input).toEqual({ host: 'claude-code', provider: 'claude-cli', model: 'haiku', credentialRef: null, enabled: false })
  expect(choice?.origin).toBe('prompt')
  expect(choice?.check).toBe('not run (observer off)')
  expect(choice?.credential).toBeNull()
  expect(calls).toEqual([])
  expect(asked).toHaveLength(1)
  expect(asked[0]).toContain('or off (capture only, no summaries)')
  expect(describeInput(choice!.input)).toBe('off (capture only)')
})

test('--observer <host>=off turns that observer off and keeps the model it had', async () => {
  const flag = parseObserverFlag('codex=off')
  // The built-in choice for Codex rides along, for an agent with no saved row to keep.
  expect(flag).toEqual({ ok: true, value: { host: 'codex', provider: 'openrouter', model: 'openrouter/auto', off: true } })
  if (!flag.ok) throw new Error('flag did not parse')
  world = createWorld({})
  const saved = new Map([['codex', { host: 'codex', provider: 'codex-cli', model: 'gpt-x', credentialRef: null, enabled: true }]] as const)
  const [kept] = await chooseObservers(world.env, ['codex'], { ...options, yes: true, flags: [flag.value], saved })
  expect(kept?.input).toEqual({ host: 'codex', provider: 'codex-cli', model: 'gpt-x', credentialRef: null, enabled: false })
  expect(kept?.check).toBe('not run (observer off)')
  const [fresh] = await chooseObservers(world.env, ['codex'], { ...options, yes: true, flags: [flag.value] })
  expect(fresh?.input).toMatchObject({ host: 'codex', provider: 'openrouter', model: 'openrouter/auto', enabled: false })
  // Off needs no key, so none is asked for or stored.
  expect(fresh?.credential).toBeNull()
  // A model can be named "off" only with its provider in front.
  expect(parseObserverFlag('codex=openrouter:off')).toEqual({ ok: true, value: { host: 'codex', provider: 'openrouter', model: 'off' } })
})

// ---- API providers, endpoints and goose -------------------------------------------

test('settingsInputFor gives each API provider its own key ref, and a local OpenAI-compatible endpoint none', () => {
  expect(settingsInputFor('codex', 'anthropic-api', 'claude-haiku-5-5')).toEqual({ host: 'codex', provider: 'anthropic-api', model: 'claude-haiku-5-5', credentialRef: 'anthropic', enabled: true })
  expect(settingsInputFor('codex', 'qwen-api', 'qwen3.8-flash', 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1')).toMatchObject({ credentialRef: 'dashscope', endpoint: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1' })
  expect(settingsInputFor('codex', 'openai-compatible', 'llama3.2', 'http://127.0.0.1:11434/v1')).toMatchObject({ credentialRef: null, endpoint: 'http://127.0.0.1:11434/v1' })
  expect(settingsInputFor('codex', 'openai-compatible', 'llama-4', 'https://api.groq.com/openai/v1')).toMatchObject({ credentialRef: 'openai-compatible' })
  expect(settingsInputFor('codex', 'goose-cli', 'ollama/qwen2.5:1.5b').credentialRef).toBeNull()
})

test('describeInput names the endpoint of an endpoint provider', () => {
  expect(describeInput(settingsInputFor('codex', 'openai-compatible', 'llama3.2', 'http://127.0.0.1:11434/v1'))).toBe('openai-compatible/llama3.2 at http://127.0.0.1:11434/v1')
})

test('the plain prompt asks an endpoint provider for its address, offers a default, and refuses one the rules forbid', async () => {
  world = createWorld({ interactive: true, answers: ['openai-compatible:llama3.2', 'http://example.com/v1', ''] })
  const asked = recordingAsk(world)
  const [choice] = await chooseObservers(world.env, ['claude-code'], { ...options, skipCheck: true, missingClis: async () => new Map() })
  expect(choice?.input).toEqual({ host: 'claude-code', provider: 'openai-compatible', model: 'llama3.2', credentialRef: null, enabled: true, endpoint: 'http://127.0.0.1:11434/v1' })
  expect(choice?.credentialNote).toBe('no key needed')
  expect(asked[1]).toBe('Endpoint for openai-compatible on claude-code (https, or http on this machine; Enter for http://127.0.0.1:11434/v1) > ')
  expect(world.out).toContain('the endpoint must use https unless it is on this machine (127.0.0.1, ::1 or localhost)')
})

test('Qwen takes the Singapore DashScope address by default and asks for its key', async () => {
  world = createWorld({ interactive: true, answers: ['qwen-api:qwen3.8-flash', ''], keychainRefs: ['dashscope'] })
  const [choice] = await chooseObservers(world.env, ['claude-code'], { ...options, skipCheck: true, missingClis: async () => new Map() })
  expect(choice?.input).toMatchObject({ provider: 'qwen-api', credentialRef: 'dashscope', endpoint: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1' })
  expect(choice?.credentialNote).toContain('dashscope present')
})

test('the plain prompt refuses a goose model it cannot run safely, and auggie-cli with its reason', async () => {
  world = createWorld({ interactive: true, answers: ['goose-cli:claude-code/sonnet', 'auggie-cli:x', 'goose-cli:ollama/qwen2.5:1.5b'] })
  const asked = recordingAsk(world)
  const [choice] = await chooseObservers(world.env, ['claude-code'], { ...options, skipCheck: true, missingClis: async () => new Map() })
  expect(choice?.input).toMatchObject({ provider: 'goose-cli', model: 'ollama/qwen2.5:1.5b' })
  expect(world.out).toContain('goose-cli models are <provider>/<model>, provider one of anthropic, openai, google, openrouter, xai, ollama, tetrate')
  expect(world.out).toContain(`auggie-cli cannot be picked: ${UNPROVEN_CLI_PROVIDERS['auggie-cli']}`)
  expect(asked[0]).toContain(`auggie-cli (${UNPROVEN_CLI_PROVIDERS['auggie-cli']})`)
})

test('an agent whose own CLI cannot observe is told why before the question', async () => {
  world = createWorld({ interactive: true, answers: [''], keychainRefs: ['openrouter'] })
  await chooseObservers(world.env, ['gemini-cli'], { ...options, skipCheck: true, missingClis: async () => new Map(), observerNote: (host) => selfObserverNote(INSTALL_PROFILES[host]) })
  expect(selfObserverNote(INSTALL_PROFILES.codex)).toBeNull()
  expect(world.out).toContain(`Gemini CLI cannot summarise through its own CLI: ${NO_TOOLS_OFF}. Any provider below can.`)
})

test('--observer-endpoint gives an endpoint provider its address; Qwen without one takes the default', () => {
  expect(withObserverEndpoint([{ host: 'codex', provider: 'openai-compatible', model: 'm' }], 'http://localhost:1234/v1/')).toEqual({ ok: true, value: [{ host: 'codex', provider: 'openai-compatible', model: 'm', endpoint: 'http://localhost:1234/v1' }] })
  expect(withObserverEndpoint([{ host: 'codex', provider: 'qwen-api', model: 'm' }], null)).toEqual({ ok: true, value: [{ host: 'codex', provider: 'qwen-api', model: 'm', endpoint: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1' }] })
  expect(withObserverEndpoint([{ host: 'codex', provider: 'openai-compatible', model: 'm' }], null)).toEqual({ ok: false, error: '--observer codex=openai-compatible:... needs --observer-endpoint <url>' })
  expect(withObserverEndpoint([{ host: 'codex', provider: 'openai-compatible', model: 'm' }], 'http://10.0.0.2/v1')).toEqual({ ok: false, error: '--observer-endpoint: the endpoint must use https unless it is on this machine (127.0.0.1, ::1 or localhost)' })
  expect(withObserverEndpoint([{ host: 'codex', provider: 'openrouter', model: 'm' }], 'https://x.example.com')).toEqual({ ok: false, error: '--observer-endpoint is only for an --observer naming qwen-api or openai-compatible' })
  expect(withObserverEndpoint([{ host: 'codex', provider: 'goose-cli', model: 'claude-code/x' }], null)).toEqual({ ok: false, error: '--observer codex=goose-cli:...: goose-cli models are <provider>/<model>, provider one of anthropic, openai, google, openrouter, xai, ollama, tetrate' })
})

test('a bare goose-cli asks for a model in goose\'s format, lists none, and refuses one it cannot run', async () => {
  world = createWorld({ interactive: true, answers: ['goose-cli', 'ollama', 'ollama/qwen2.5:7b'], cliRunner: () => cli({ listModels: async () => { throw new Error('goose has no model list') } }) })
  const asked = recordingAsk(world)
  const [choice] = await chooseObservers(world.env, ['claude-code'], { ...options, skipCheck: true, missingClis: async () => new Map() })
  expect(choice?.input).toMatchObject({ provider: 'goose-cli', model: 'ollama/qwen2.5:7b' })
  expect(asked[1]).toBe('Model for goose-cli on claude-code, as <goose provider>/<model> such as ollama/qwen2.5:7b > ')
  expect(world.out.some((line) => line.includes('model list unavailable'))).toBe(false)
  expect(world.out).toContain('goose-cli models are <provider>/<model>, provider one of anthropic, openai, google, openrouter, xai, ollama, tetrate')
})

test('a built-in object name is not taken for an unproven provider', async () => {
  world = createWorld({ interactive: true, answers: ['constructor', ''] })
  await chooseObservers(world.env, ['claude-code'], { ...options, skipCheck: true, missingClis: async () => new Map() })
  expect(world.out.some((line) => line.startsWith('constructor cannot be picked'))).toBe(false)
})

test('the OpenAI-compatible observer offers the local LLM embedding address when no observer has one saved', () => {
  const embeddingUrl = 'http://127.0.0.1:1234/v1'
  expect(defaultEndpoint('openai-compatible', 'codex', undefined, embeddingUrl)).toBe(embeddingUrl)
  expect(defaultEndpoint('openai-compatible', 'codex', undefined, null)).toBe(LOCAL_ENDPOINT)
  const saved = new Map([['codex', { host: 'codex', provider: 'openai-compatible', model: 'm', credentialRef: null, enabled: true, endpoint: 'http://127.0.0.1:9/v1' }]]) as Parameters<typeof defaultEndpoint>[2]
  expect(defaultEndpoint('openai-compatible', 'codex', saved, embeddingUrl)).toBe('http://127.0.0.1:9/v1')
  expect(defaultEndpoint('qwen-api', 'codex', undefined, embeddingUrl)).not.toBe(embeddingUrl)
})

const TOKEN = 'sk-ant-oat01-FAKE-INSTALL-TOKEN-0000000'

test('--observer-token-stdin keeps a claude-cli token for the key store, and the install check runs on it', async () => {
  world = createWorld({ stdin: `${TOKEN}\n` })
  const seen: (string | null)[] = []
  world.env.runnerFor = (_settings, credentials) => ({ run: async () => (seen.push(credentials.get(CLAUDE_TOKEN_REF)), { text: 'ok', model: 'haiku' }) })
  const [choice] = await chooseObservers(world.env, ['claude-code'], { ...options, yes: true, observerTokenStdin: true })
  expect(choice?.input).toMatchObject({ provider: 'claude-cli' })
  expect(choice?.credential).toEqual({ ref: CLAUDE_TOKEN_REF, value: TOKEN })
  expect(choice?.credentialNote).toContain('long-lived token')
  expect(choice?.credentialNote).not.toContain(TOKEN)
  expect(seen).toEqual([TOKEN])
})

test('the wizard asks for a token once, masked, when the claude-cli login is failing on this machine; Enter keeps the CLI login', async () => {
  world = createWorld({ interactive: true, answers: ['', ''], secrets: [TOKEN], keychainRefs: ['openrouter'] })
  const asked: string[] = []
  const askSecret = world.env.io.askSecret
  world.env.io.askSecret = async (question) => (asked.push(question), askSecret(question))
  const choices = await chooseObservers(world.env, ['claude-code', 'opencode'], { ...options, skipCheck: true, missingClis: async () => new Map(), offerClaudeToken: true })
  expect(asked).toHaveLength(1)
  expect(asked[0]).toContain('claude setup-token')
  expect(asked[0]).toContain('not shown')
  expect(choices[0]?.credential).toEqual({ ref: CLAUDE_TOKEN_REF, value: TOKEN })

  world = createWorld({ interactive: true, answers: [''], secrets: [''] })
  const [kept] = await chooseObservers(world.env, ['claude-code'], { ...options, skipCheck: true, missingClis: async () => new Map(), offerClaudeToken: true })
  expect(kept?.credential).toBeNull()
  expect(kept?.credentialNote).toBe('no key needed')
})

test('with the login working, the wizard asks nothing about a token', async () => {
  world = createWorld({ interactive: true, answers: [''] })
  const asked: string[] = []
  world.env.io.askSecret = async (question) => (asked.push(question), '')
  await chooseObservers(world.env, ['claude-code'], { ...options, skipCheck: true, missingClis: async () => new Map() })
  expect(asked).toEqual([])
})

test('a claude-cli check that fails on its login offers the token, and passes on it', async () => {
  world = createWorld({ interactive: true, answers: [''], secrets: [TOKEN] })
  const seen: (string | null)[] = []
  world.env.runnerFor = (_settings, credentials) => ({
    run: async () => {
      const token = credentials.get(CLAUDE_TOKEN_REF)
      seen.push(token)
      if (token === null) throw new ObserverError('auth_expired', 'claude exited 1: OAuth session expired')
      return { text: 'ok', model: 'haiku' }
    },
  })
  const [choice] = await chooseObservers(world.env, ['claude-code'], { ...options, missingClis: async () => new Map() })
  expect(seen).toEqual([null, TOKEN])
  expect(choice).toMatchObject({ check: 'ok', credential: { ref: CLAUDE_TOKEN_REF, value: TOKEN } })
})

test('a stored token is not asked for again', async () => {
  world = createWorld({ interactive: true, answers: [''], keychainRefs: [CLAUDE_TOKEN_REF] })
  const asked: string[] = []
  world.env.io.askSecret = async (question) => (asked.push(question), '')
  const [choice] = await chooseObservers(world.env, ['claude-code'], { ...options, skipCheck: true, missingClis: async () => new Map(), offerClaudeToken: true })
  expect(asked).toEqual([])
  expect(choice?.credentialNote).toContain('long-lived token present')
})

test('--observer-token-stdin is refused with no claude-cli observer, with a second stdin reader, or for a value that cannot be stored', async () => {
  world = createWorld({ stdin: TOKEN })
  await expect(chooseObservers(world.env, ['claude-code'], { ...options, yes: true, observerTokenStdin: true, flags: [{ host: 'claude-code', provider: 'openrouter', model: 'm' }], skipCheck: true, credentialStdin: true }))
    .rejects.toThrow(/stdin/)
  world = createWorld({ stdin: TOKEN, keychainRefs: ['openrouter'] })
  await expect(chooseObservers(world.env, ['claude-code'], { ...options, yes: true, observerTokenStdin: true, flags: [{ host: 'claude-code', provider: 'openrouter', model: 'm' }], skipCheck: true }))
    .rejects.toThrow('--observer-token-stdin is for the claude-cli observer, and no agent here uses it')
  world = createWorld({ stdin: 'has a space' })
  const refused = chooseObservers(world.env, ['claude-code'], { ...options, yes: true, observerTokenStdin: true, skipCheck: true })
  await expect(refused).rejects.toBeInstanceOf(ChoiceError)
  await expect(refused).rejects.not.toThrow(/has a space/)
})
