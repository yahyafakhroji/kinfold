// The per-host observer choice: keep the built-in default or name a
// provider and model, from --observer, --yes or a prompt. A choice is saved
// only after one tiny call through that provider's real runner answers, so a
// broken choice is caught at install time, not at the first batch. There is
// no silent fallback: a failed check is reported by its error class and asked
// again, or under --yes ends the install with a non-zero exit.

import { type CredentialProvider, NO_CREDENTIALS, assertStorableValue, isSystemCredentialRef } from '../secrets/credentials'
import { type KeyStore, credentialProviderOf } from '../secrets/key-store'
import { CHECK_PROMPT } from '../observer/check-prompt'
import { OPENROUTER_CREDENTIAL_REF, builtInSettings, credentialRefFor, providerTakesKey } from '../observer/settings'
import { runPlantedCheck } from '../observer/planted-check'
import { CLI_LOGIN_PROVIDERS, type CliLoginProvider, OBSERVER_PROVIDERS, type ObserverProvider, type ObserverSettings, toObserverError } from '../observer/types'
import type { ObserverSettingsInput } from '../store/observer-settings-store'
import type { InstallHost } from './detect'
import type { InstallEnv } from './env'
import { keyStoreOf } from './key-store-choice'

export const MAX_CHOICE_ATTEMPTS = 5

const MAX_LISTED_MODELS = 20
const MAX_MODEL_NAME_CHARS = 200

export { CHECK_PROMPT }

export interface ObserverFlag {
  host: InstallHost
  provider: ObserverProvider
  model: string
}

export interface ChoiceOptions {
  yes: boolean
  dryRun: boolean
  skipCheck: boolean
  replaceCredential: boolean
  credentialStdin: boolean
  flags: readonly ObserverFlag[]
  /** What each host has now (setup/prefill.ts); under --yes a host with no flag keeps its row instead of taking the built-in default. */
  saved?: ReadonlyMap<InstallHost, ObserverSettingsInput>
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
  check: 'ok' | 'skipped' | 'unchanged' | 'not run (dry run)'
}

/** Ends the install with a non-zero exit; the message carries no secret. */
export class ChoiceError extends Error {
  override readonly name = 'ChoiceError'
}

export function settingsInputFor(host: string, provider: ObserverProvider, model: string): ObserverSettingsInput {
  return { host, provider, model, credentialRef: providerTakesKey(provider) ? OPENROUTER_CREDENTIAL_REF : null, enabled: true }
}

export function asSettings(input: ObserverSettingsInput): ObserverSettings {
  return { provider: input.provider, model: input.model, credentialRef: input.credentialRef, enabled: input.enabled, source: 'host' }
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
  return `${input.provider}/${input.model}`
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

/** The provider was named without a model: show that CLI's models, then ask for the name. */
async function askModel(env: InstallEnv, host: InstallHost, provider: CliLoginProvider): Promise<string> {
  showModels(env, provider, await listModelsFor(env, provider))
  for (let attempt = 0; attempt < MAX_CHOICE_ATTEMPTS; attempt += 1) {
    const model = (await env.io.ask(`Model for ${provider} on ${host} > `)).trim()
    if (model !== '') return model
  }
  throw new ChoiceError(`no model named for the ${host} observer`)
}

async function promptCandidate(env: InstallEnv, host: InstallHost): Promise<Candidate> {
  const fallback = defaultInput(host)
  for (let attempt = 0; attempt < MAX_CHOICE_ATTEMPTS; attempt += 1) {
    const answer = (await env.io.ask(
      `Observer for ${host}: default ${describeInput(fallback)}. Providers: ${OBSERVER_PROVIDERS.join(', ')}.\n` +
        `Press Enter to keep the default, or type provider:model (a bare ${CLI_LOGIN_PROVIDERS.join(' or ')} lists that CLI's models) > `,
    )).trim()
    if (answer === '') return { input: fallback, origin: 'default' }
    const parsed = parseProviderModel(answer)
    if (parsed !== null) return { input: settingsInputFor(host, parsed.provider, parsed.model), origin: 'prompt' }
    if (isCliLoginProvider(answer)) return { input: settingsInputFor(host, answer, await askModel(env, host, answer)), origin: 'prompt' }
    env.out(`"provider:model" expected, with provider one of ${OBSERVER_PROVIDERS.join(', ')}`)
  }
  throw new ChoiceError(`no valid observer choice for ${host}`)
}

async function pickCandidate(env: InstallEnv, host: InstallHost, options: ChoiceOptions, retry: boolean): Promise<Candidate> {
  const flag = options.flags.find((entry) => entry.host === host)
  if (!retry && flag !== undefined) return { input: settingsInputFor(host, flag.provider, flag.model), origin: 'flag' }
  const saved = options.saved?.get(host)
  if (!retry && options.yes && saved !== undefined) return { input: saved, origin: 'saved' }
  if (!retry && options.yes) return { input: defaultInput(host), origin: 'default' }
  if (env.io.interactive && !options.yes) return promptCandidate(env, host)
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
