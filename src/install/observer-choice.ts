// The per-host observer choice: keep the built-in default or name a
// provider and model, from --observer, --yes or a prompt. A choice is saved
// only after one tiny call through that provider's real runner answers, so a
// broken choice is caught at install time, not at the first batch. There is
// no silent fallback: a failed check is reported by its error class and asked
// again, or under --yes ends the install with a non-zero exit.

import { type CredentialProvider, NO_CREDENTIALS, assertStorableValue, isSystemCredentialRef } from '../secrets/credentials'
import { type KeyStore, credentialProviderOf } from '../secrets/key-store'
import { CHECK_PROMPT } from '../observer/check-prompt'
import type { AgentProfile } from '../agents/profile'
import type { Parsed } from '../context/types'
import { DASHSCOPE_DEFAULT_ENDPOINT, checkEndpoint, isLoopbackEndpoint } from '../observer/endpoint'
import { parseGooseModel } from '../observer/runners/goose-cli'
import { DEFAULT_CREDENTIAL_REFS, OPENAI_COMPATIBLE_CREDENTIAL_REF, builtInSettings, credentialRefFor, isEndpointProvider } from '../observer/settings'
import { runPlantedCheck } from '../observer/planted-check'
import {
  CLI_LOGIN_PROVIDERS,
  type CliLoginProvider,
  ENDPOINT_PROVIDERS,
  type EndpointProvider,
  OBSERVER_PROVIDERS,
  type ObserverProvider,
  type ObserverSettings,
  UNPROVEN_CLI_PROVIDERS,
  toObserverError,
} from '../observer/types'
import type { ObserverSettingsInput } from '../store/observer-settings-store'
import type { InstallHost } from './detect'
import type { InstallEnv } from './env'
import type { MissingClis } from './observer-clis'
import { keyStoreOf } from './key-store-choice'

export const MAX_CHOICE_ATTEMPTS = 5

const MAX_LISTED_MODELS = 20
const MAX_MODEL_NAME_CHARS = 200

export { CHECK_PROMPT }

export interface ObserverFlag {
  host: InstallHost
  provider: ObserverProvider
  model: string
  /** From --observer-endpoint, for an endpoint provider (withObserverEndpoint). */
  endpoint?: string
  /** `--observer <host>=off`: capture only. The provider and model are then the built-in ones, used when the agent has no saved row to keep. */
  off?: true
}

/** What the wizard and the plain prompt call the choice that stops summaries for one agent. */
export const OFF_LABEL = 'off (capture only, no summaries)'

export interface ChoiceOptions {
  yes: boolean
  dryRun: boolean
  skipCheck: boolean
  replaceCredential: boolean
  credentialStdin: boolean
  flags: readonly ObserverFlag[]
  /** What each host has now (setup/prefill.ts); under --yes a host with no flag keeps its row instead of taking the built-in default. */
  saved?: ReadonlyMap<InstallHost, ObserverSettingsInput>
  /** The local LLM address the embeddings use, offered for an OpenAI-compatible observer; read only when that question is asked. */
  embeddingUrl?: () => Promise<string | null>
  /** The providers whose CLI is not on this machine; read only when a question is asked, so a run that asks nothing looks for no CLI. Absent: every provider is offered. */
  missingClis?: () => Promise<MissingClis>
  /**
   * What the question says first about the agent's own CLI (selfObserverNote).
   * Passed in by the caller, which holds the profile table: importing it here
   * would load the profiles from inside a profile's own imports.
   */
  observerNote?: (host: InstallHost) => string | null
}

export interface PendingCredential {
  ref: string
  value: string
}

export interface ObserverChoice {
  input: ObserverSettingsInput
  origin: 'default' | 'flag' | 'prompt' | 'saved'
  /** A key entered this run, stored in the key store only once the plan runs. */
  credential: PendingCredential | null
  credentialNote: string
  check: 'ok' | 'skipped' | 'unchanged' | 'not run (dry run)' | 'not run (observer off)'
}

/** Ends the install with a non-zero exit; the message carries no secret. */
export class ChoiceError extends Error {
  override readonly name = 'ChoiceError'
}

/** A server on this machine needs no key; one across the network gets the OpenAI-compatible key-store entry. */
function defaultRef(provider: ObserverProvider, endpoint: string | undefined): string | null {
  if (provider === 'openai-compatible') return endpoint !== undefined && isLoopbackEndpoint(endpoint) ? null : OPENAI_COMPATIBLE_CREDENTIAL_REF
  return DEFAULT_CREDENTIAL_REFS[provider] ?? null
}

export function settingsInputFor(host: string, provider: ObserverProvider, model: string, endpoint?: string): ObserverSettingsInput {
  const withEndpoint = endpoint !== undefined && isEndpointProvider(provider) ? { endpoint } : {}
  return { host, provider, model, credentialRef: defaultRef(provider, endpoint), enabled: true, ...withEndpoint }
}

export function asSettings(input: ObserverSettingsInput): ObserverSettings {
  return { provider: input.provider, model: input.model, credentialRef: input.credentialRef, enabled: input.enabled, source: 'host', ...(input.endpoint === undefined ? {} : { endpoint: input.endpoint }) }
}

export function defaultInput(host: InstallHost): ObserverSettingsInput {
  const builtIn = builtInSettings(host)
  return settingsInputFor(host, builtIn.provider, builtIn.model)
}

/** "provider:model"; the model may itself contain ':' or '/'. */
export function parseProviderModel(value: string): { provider: ObserverProvider; model: string } | null {
  const at = value.indexOf(':')
  if (at <= 0) return null
  const provider = value.slice(0, at).trim()
  const model = value.slice(at + 1).trim()
  if (!OBSERVER_PROVIDERS.includes(provider as ObserverProvider) || model === '') return null
  return { provider: provider as ObserverProvider, model }
}

export function describeInput(input: ObserverSettingsInput): string {
  if (!input.enabled) return 'off (capture only)'
  return `${input.provider}/${input.model}${input.endpoint === undefined ? '' : ` at ${input.endpoint}`}`
}

/**
 * The address offered for an endpoint provider: this agent's saved one, then
 * another agent's, then (for an OpenAI-compatible server) the local LLM the
 * embeddings already use, then the usual local or regional one. The two
 * settings stay separate; this only saves typing the same address twice.
 */
export function defaultEndpoint(provider: EndpointProvider, host: string, saved?: ReadonlyMap<InstallHost, ObserverSettingsInput>, embeddingUrl?: string | null): string {
  const rows = [...(saved?.values() ?? [])].filter((row) => row.provider === provider && row.endpoint !== undefined)
  const own = rows.find((row) => row.host === host) ?? rows[0]
  if (own?.endpoint !== undefined) return own.endpoint
  if (provider === 'openai-compatible' && embeddingUrl !== undefined && embeddingUrl !== null) return embeddingUrl
  return provider === 'qwen-api' ? DASHSCOPE_DEFAULT_ENDPOINT : LOCAL_ENDPOINT
}

/** Ollama's address; LM Studio's is http://127.0.0.1:1234/v1. */
export const LOCAL_ENDPOINT = 'http://127.0.0.1:11434/v1'

const ENDPOINT_RULE: Readonly<Record<EndpointProvider, string>> = {
  'openai-compatible': 'https, or http on this machine',
  'qwen-api': 'an https DashScope URL',
}

export function endpointQuestion(provider: EndpointProvider, host: string, fallback: string): string {
  return `Endpoint for ${provider} on ${host} (${ENDPOINT_RULE[provider]}; Enter for ${fallback})`
}

/** Why the agent's own CLI cannot run its summaries, said before the question; null when it can. */
export function selfObserverNote(profile: AgentProfile): string | null {
  const login = profile.observerLogin
  return 'out' in login ? `${profile.name} cannot summarise through its own CLI: ${login.out}. Any provider below can.` : null
}

/** The rule a model breaks for its provider, or null; only goose-cli has a format of its own. */
export function modelProblem(provider: ObserverProvider, model: string): string | null {
  if (provider !== 'goose-cli') return null
  const parsed = parseGooseModel(model)
  return parsed.ok ? null : parsed.error
}

/**
 * Puts --observer-endpoint on each --observer naming an endpoint provider.
 * Qwen without one takes the Singapore DashScope URL; the OpenAI-compatible
 * provider has no default, since only the user knows their server.
 */
export function withObserverEndpoint(flags: readonly ObserverFlag[], endpoint: string | null): Parsed<ObserverFlag[]> {
  const out: ObserverFlag[] = []
  let used = false
  for (const flag of flags) {
    const problem = flag.off === true ? null : modelProblem(flag.provider, flag.model)
    if (problem !== null) return { ok: false, error: `--observer ${flag.host}=${flag.provider}:...: ${problem}` }
    if (flag.off === true || !isEndpointProvider(flag.provider)) {
      out.push(flag)
      continue
    }
    used = true
    const raw = endpoint ?? (flag.provider === 'qwen-api' ? DASHSCOPE_DEFAULT_ENDPOINT : null)
    if (raw === null) return { ok: false, error: `--observer ${flag.host}=${flag.provider}:... needs --observer-endpoint <url>` }
    const checked = checkEndpoint(flag.provider, raw)
    if (!checked.ok) return { ok: false, error: `--observer-endpoint: ${checked.error}` }
    out.push({ ...flag, endpoint: checked.value })
  }
  if (endpoint !== null && !used) return { ok: false, error: `--observer-endpoint is only for an --observer naming ${ENDPOINT_PROVIDERS.join(' or ')}` }
  return { ok: true, value: out }
}

/**
 * The same agent with its observer off. The provider and model stay in the
 * row, so switching it back on (the dashboard, or a later install) returns to
 * what was chosen rather than to the built-in default.
 */
export function offInput(current: ObserverSettingsInput): ObserverSettingsInput {
  return { ...current, enabled: false }
}

/** What a flag names: a provider and model, or off, which keeps the agent's saved provider and model when it has one. */
export function flagInput(host: InstallHost, flag: ObserverFlag, saved?: ObserverSettingsInput): ObserverSettingsInput {
  return flag.off === true ? offInput(saved ?? settingsInputFor(host, flag.provider, flag.model)) : settingsInputFor(host, flag.provider, flag.model, flag.endpoint)
}

export interface Candidate {
  input: ObserverSettingsInput
  origin: ObserverChoice['origin']
}

export function isCliLoginProvider(provider: string): provider is CliLoginProvider {
  return (CLI_LOGIN_PROVIDERS as readonly string[]).includes(provider)
}

/** Up to 20 names the CLI reports, as plain lines; or the error class when it cannot list. Names are never interpreted; a name with a control or format character (an escape, a bidi override, a zero-width) is dropped. */
export function showModels(env: InstallEnv, provider: CliLoginProvider, models: readonly string[] | { errorClass: string }): void {
  if ('errorClass' in models) {
    env.out(`model list unavailable (${models.errorClass}); type a model name`)
    return
  }
  const names = models.filter((name) => name.length > 0 && name.length <= MAX_MODEL_NAME_CHARS && !/[\p{Cc}\p{Cf}]/u.test(name)).slice(0, MAX_LISTED_MODELS)
  if (names.length === 0) {
    env.out(`${provider} reported no models; type a model name`)
    return
  }
  env.out(`${provider} models (first ${names.length}):`)
  for (const name of names) env.out(`  ${name}`)
}

export async function listModelsFor(env: InstallEnv, provider: CliLoginProvider): Promise<string[] | { errorClass: string }> {
  try {
    return await env.cliRunnerFor({ provider, model: '-', credentialRef: null, enabled: true, source: 'host' }).listModels()
  } catch (error: unknown) {
    return { errorClass: toObserverError(error).errorClass }
  }
}

/** What the model question adds for goose-cli, whose model names a goose provider. */
export const GOOSE_MODEL_HINT = 'as <goose provider>/<model> such as ollama/qwen2.5:7b'

/** The provider was named without a model: show that CLI's models where it can list them, then ask for the name. */
async function askModel(env: InstallEnv, host: InstallHost, provider: CliLoginProvider): Promise<string> {
  if (LISTING_PROVIDERS.includes(provider)) showModels(env, provider, await listModelsFor(env, provider))
  const hint = provider === 'goose-cli' ? `, ${GOOSE_MODEL_HINT}` : ''
  for (let attempt = 0; attempt < MAX_CHOICE_ATTEMPTS; attempt += 1) {
    const model = (await env.io.ask(`Model for ${provider} on ${host}${hint} > `)).trim()
    const problem = model === '' ? null : modelProblem(provider, model)
    if (problem !== null) env.out(problem)
    else if (model !== '') return model
  }
  throw new ChoiceError(`no model named for the ${host} observer`)
}

/** What a default that cannot run here says, on a row and as a line. */
export const pickAnother = (reason: string): string => `${reason}; pick another`

/** CLI providers that can list their models; goose has no command for it. */
export const LISTING_PROVIDERS: readonly CliLoginProvider[] = CLI_LOGIN_PROVIDERS.filter((provider) => provider !== 'goose-cli')

/** The plain question: the wizard's list as two lines, each provider that cannot run here with its reason. */
function candidateQuestion(host: InstallHost, fallback: ObserverSettingsInput, missing: MissingClis): string {
  const stale = missing.get(fallback.provider)
  const providers = [
    ...OBSERVER_PROVIDERS.map((provider) => (missing.has(provider) ? `${provider} (${missing.get(provider)})` : provider)),
    ...Object.entries(UNPROVEN_CLI_PROVIDERS).map(([provider, reason]) => `${provider} (${reason})`),
  ]
  const listing = LISTING_PROVIDERS.filter((provider) => !missing.has(provider))
  const bare = listing.length === 0 ? '' : ` (a bare ${listing.join(' or ')} lists that CLI's models)`
  return (
    `Observer for ${host}: default ${describeInput(fallback)}${stale === undefined ? '' : ` (${pickAnother(stale)})`}. Providers: ${providers.join(', ')}.\n` +
    `${stale === undefined ? 'Press Enter to keep the default, or type' : 'Type'} provider:model${bare}, or ${OFF_LABEL} > `
  )
}

/** The address for an endpoint provider, asked until it passes the rules. */
async function askEndpoint(env: InstallEnv, host: InstallHost, provider: EndpointProvider, options: ChoiceOptions): Promise<string> {
  const fallback = defaultEndpoint(provider, host, options.saved)
  for (let attempt = 0; attempt < MAX_CHOICE_ATTEMPTS; attempt += 1) {
    const answer = (await env.io.ask(`${endpointQuestion(provider, host, fallback)} > `)).trim()
    const checked = checkEndpoint(provider, answer === '' ? fallback : answer)
    if (checked.ok) return checked.value
    env.out(checked.error)
  }
  throw new ChoiceError(`no valid endpoint for the ${host} observer`)
}

/** The unproven provider an answer names, as "auggie-cli" or "auggie-cli:model". */
function unprovenNamed(answer: string): string | null {
  const name = answer.split(':')[0]!.trim()
  return Object.hasOwn(UNPROVEN_CLI_PROVIDERS, name) ? name : null
}

async function promptCandidate(env: InstallEnv, host: InstallHost, options: ChoiceOptions): Promise<Candidate> {
  const fallback = defaultInput(host)
  const missing: MissingClis = (await options.missingClis?.()) ?? new Map()
  const stale = missing.get(fallback.provider)
  const note = options.observerNote?.(host) ?? null
  if (note !== null) env.out(note)
  for (let attempt = 0; attempt < MAX_CHOICE_ATTEMPTS; attempt += 1) {
    const answer = (await env.io.ask(candidateQuestion(host, fallback, missing))).trim()
    if (answer === '' && stale === undefined) return { input: fallback, origin: 'default' }
    if (answer.toLowerCase() === 'off') return { input: offInput(options.saved?.get(host) ?? fallback), origin: 'prompt' }
    const parsed = parseProviderModel(answer)
    const named = parsed?.provider ?? (isCliLoginProvider(answer) ? answer : null)
    const reason = named === null ? undefined : missing.get(named)
    const unproven = unprovenNamed(answer)
    const problem = parsed === null ? null : modelProblem(parsed.provider, parsed.model)
    if (answer === '' && stale !== undefined) env.out(pickAnother(stale))
    else if (unproven !== null) env.out(`${unproven} cannot be picked: ${UNPROVEN_CLI_PROVIDERS[unproven]}`)
    else if (named !== null && reason !== undefined) env.out(`${named} cannot be picked: ${reason}`)
    else if (problem !== null) env.out(problem)
    else if (parsed !== null && isEndpointProvider(parsed.provider)) {
      return { input: settingsInputFor(host, parsed.provider, parsed.model, await askEndpoint(env, host, parsed.provider, options)), origin: 'prompt' }
    } else if (parsed !== null) return { input: settingsInputFor(host, parsed.provider, parsed.model), origin: 'prompt' }
    else if (isCliLoginProvider(answer)) return { input: settingsInputFor(host, answer, await askModel(env, host, answer)), origin: 'prompt' }
    else env.out(`"provider:model" or "off" expected, with provider one of ${OBSERVER_PROVIDERS.join(', ')}`)
  }
  throw new ChoiceError(`no valid observer choice for ${host}`)
}

async function pickCandidate(env: InstallEnv, host: InstallHost, options: ChoiceOptions, retry: boolean): Promise<Candidate> {
  const flag = options.flags.find((entry) => entry.host === host)
  const saved = options.saved?.get(host)
  if (!retry && flag !== undefined) return { input: flagInput(host, flag, saved), origin: 'flag' }
  if (!retry && options.yes && saved !== undefined) return { input: saved, origin: 'saved' }
  if (!retry && options.yes) return { input: defaultInput(host), origin: 'default' }
  if (env.io.interactive && !options.yes) return promptCandidate(env, host, options)
  throw new ChoiceError(`cannot ask about the ${host} observer without a TTY; pass --yes or --observer ${host}=<provider>:<model>`)
}

type CredentialState = { kind: 'none' } | { kind: 'stored'; label: string } | { kind: 'entered'; value: string; label: string } | { kind: 'dry-run'; label: string }

export interface CredentialSession {
  entered: Map<string, string>
  stdinUsed: boolean
}

/** The Keychain keeps today's wording; any other store names its own place. */
function promptPlace(store: KeyStore): string {
  return store.kind === 'keychain' ? 'the macOS Keychain' : store.place
}

async function readCredentialValue(env: InstallEnv, store: KeyStore, ref: string, options: ChoiceOptions, session: CredentialSession): Promise<string> {
  let value: string
  if (options.credentialStdin) {
    if (session.stdinUsed) throw new ChoiceError(`stdin was already read; cannot read another key for ${ref}`)
    session.stdinUsed = true
    value = await env.io.readStdin()
  } else if (options.yes) {
    // --yes never asks, even on a terminal: a child `install --yes` must not stop at a question.
    throw new ChoiceError(`the ${ref} key is not in the ${store.label} and --yes asks nothing; pass --credential-stdin`)
  } else if (env.io.interactive) {
    value = await env.io.askSecret(`Key for ${ref} (stored in ${promptPlace(store)}, not shown) > `)
  } else {
    throw new ChoiceError(`the ${ref} key is not in the ${store.label} and there is no TTY to ask; pass --credential-stdin`)
  }
  const trimmed = value.replace(/[\r\n]+$/, '').trim()
  try {
    assertStorableValue(trimmed)
  } catch (error: unknown) {
    throw new ChoiceError(error instanceof Error ? error.message : 'credential refused')
  }
  return trimmed
}

async function resolveCredential(env: InstallEnv, input: ObserverSettingsInput, options: ChoiceOptions, session: CredentialSession): Promise<CredentialState> {
  const ref = credentialRefFor(asSettings(input))
  if (ref === null) return { kind: 'none' }
  if (isSystemCredentialRef(ref)) throw new ChoiceError(`${ref} is a key Kinfold keeps for itself; choose another credential ref`)
  const store = keyStoreOf(env)
  if (store === null) throw new ChoiceError(`${input.provider} needs a key, and storing keys needs the macOS Keychain; ${env.platform} is not supported yet`)
  const label = store.label
  const known = session.entered.get(ref)
  if (known !== undefined) return { kind: 'entered', value: known, label }
  if (store.exists(ref) && !options.replaceCredential) return { kind: 'stored', label }
  if (options.dryRun) return { kind: 'dry-run', label }
  const value = await readCredentialValue(env, store, ref, options, session)
  session.entered.set(ref, value)
  return { kind: 'entered', value, label }
}

function credentialNote(state: CredentialState, ref: string | null): string {
  if (state.kind === 'none' || ref === null) return 'no key needed'
  if (state.kind === 'stored') return `${state.label} entry ${ref} present`
  if (state.kind === 'dry-run') return `${state.label} entry ${ref} missing or replaced: would ask for it (no echo) and store it`
  return `new key for ${ref} will be stored in the ${state.label}`
}

function checkCredentials(env: InstallEnv, session: CredentialSession): CredentialProvider {
  // Opened only when a stored key is asked for, so a check that needs none never touches the store.
  const stored = (): CredentialProvider => {
    const store = keyStoreOf(env)
    return store === null ? NO_CREDENTIALS : credentialProviderOf(store)
  }
  return { get: (ref) => session.entered.get(ref) ?? stored().get(ref) }
}

/** ok, or the ObserverError class; never the reply or the payload. */
export async function runCheck(env: InstallEnv, input: ObserverSettingsInput, credentials: CredentialProvider): Promise<{ ok: true } | { ok: false; errorClass: string }> {
  try {
    // A CLI login observer gets the plain check and then the planted-instruction test in one pass.
    if (isCliLoginProvider(input.provider)) return await runPlantedCheck(env.cliRunnerFor(asSettings(input)))
    await env.runnerFor(asSettings(input), credentials).run(CHECK_PROMPT)
    return { ok: true }
  } catch (error: unknown) {
    return { ok: false, errorClass: toObserverError(error).errorClass }
  }
}

export function newCredentialSession(): CredentialSession {
  return { entered: new Map(), stdinUsed: false }
}

/** The check ran and the provider did not pass it; only the error class, never the reply. */
export interface CheckFailure {
  failed: string
}

/** One candidate through the credential step and the test. A failure is reported and returned so the caller can ask again. */
export async function chooseObserverWith(
  env: InstallEnv,
  host: InstallHost,
  candidate: Candidate,
  options: ChoiceOptions,
  session: CredentialSession = newCredentialSession(),
): Promise<ObserverChoice | CheckFailure> {
  // Off runs no model, so there is no key to ask for and nothing to test. A row already saved as off and kept is unchanged like any other.
  if (!candidate.input.enabled && candidate.origin !== 'saved') {
    return { ...candidate, credential: null, credentialNote: 'no key needed while off', check: options.dryRun ? 'not run (dry run)' : 'not run (observer off)' }
  }
  const ref = credentialRefFor(asSettings(candidate.input))
  const state = await resolveCredential(env, candidate.input, options, session)
  const base = { ...candidate, credential: state.kind === 'entered' && ref !== null ? { ref, value: state.value } : null, credentialNote: credentialNote(state, ref) }
  if (options.dryRun) return { ...base, check: 'not run (dry run)' }
  // A row that was already saved and is kept as it is was tested when it was chosen.
  if (candidate.origin === 'saved') return { ...base, check: 'unchanged' }
  if (options.skipCheck) return { ...base, check: 'skipped' }
  const result = await runCheck(env, candidate.input, checkCredentials(env, session))
  if (result.ok) return { ...base, check: 'ok' }
  env.out(`observer check for ${host} (${describeInput(candidate.input)}) failed: ${result.errorClass}`)
  if (ref !== null) session.entered.delete(ref)
  return { failed: result.errorClass }
}

async function chooseOne(env: InstallEnv, host: InstallHost, options: ChoiceOptions, session: CredentialSession): Promise<ObserverChoice> {
  for (let attempt = 0; attempt < MAX_CHOICE_ATTEMPTS; attempt += 1) {
    const result = await chooseObserverWith(env, host, await pickCandidate(env, host, options, attempt > 0), options, session)
    if (!('failed' in result)) return result
    if (options.yes || !env.io.interactive) throw new ChoiceError(`observer check for ${host} failed: ${result.failed}`)
  }
  throw new ChoiceError(`no working observer for ${host} after ${MAX_CHOICE_ATTEMPTS} tries`)
}

export async function chooseObservers(env: InstallEnv, hosts: readonly InstallHost[], options: ChoiceOptions): Promise<ObserverChoice[]> {
  const session = newCredentialSession()
  const choices: ObserverChoice[] = []
  for (const host of hosts) choices.push(await chooseOne(env, host, options, session))
  return choices
}
