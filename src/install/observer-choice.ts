// The per-host observer choice (D7): keep the built-in default or name a
// provider and model, from --observer, --yes or a prompt. A choice is saved
// only after one tiny call through that provider's real runner answers, so a
// broken choice is caught at install time, not at the first batch. There is
// no silent fallback: a failed check is reported by its error class and asked
// again, or under --yes ends the install with a non-zero exit.

import { createKeychainProvider } from '../secrets/keychain'
import { type CredentialProvider, isSystemCredentialRef } from '../secrets/credentials'
import { assertStorableValue, credentialWriterFor } from '../secrets/keychain-writer'
import { CHECK_PROMPT } from '../observer/check-prompt'
import { OPENROUTER_CREDENTIAL_REF, builtInSettings, credentialRefFor, providerTakesKey } from '../observer/settings'
import { OBSERVER_PROVIDERS, type ObserverProvider, type ObserverSettings, toObserverError } from '../observer/types'
import type { ObserverSettingsInput } from '../store/observer-settings-store'
import type { InstallHost } from './detect'
import type { InstallEnv } from './env'

export const MAX_CHOICE_ATTEMPTS = 5

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
}

export interface PendingCredential {
  ref: string
  value: string
}

export interface ObserverChoice {
  input: ObserverSettingsInput
  origin: 'default' | 'flag' | 'prompt'
  /** A key entered this run, stored in the keychain only once the plan runs. */
  credential: PendingCredential | null
  credentialNote: string
  check: 'ok' | 'skipped' | 'not run (dry run)'
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

interface Candidate {
  input: ObserverSettingsInput
  origin: ObserverChoice['origin']
}

async function promptCandidate(env: InstallEnv, host: InstallHost): Promise<Candidate> {
  const fallback = defaultInput(host)
  for (let attempt = 0; attempt < MAX_CHOICE_ATTEMPTS; attempt += 1) {
    const answer = (await env.io.ask(
      `Observer for ${host}: default ${describeInput(fallback)}. Providers: ${OBSERVER_PROVIDERS.join(', ')}.\n` +
        'Press Enter to keep the default, or type provider:model > ',
    )).trim()
    if (answer === '') return { input: fallback, origin: 'default' }
    const parsed = parseProviderModel(answer)
    if (parsed !== null) return { input: settingsInputFor(host, parsed.provider, parsed.model), origin: 'prompt' }
    env.out(`"provider:model" expected, with provider one of ${OBSERVER_PROVIDERS.join(', ')}`)
  }
  throw new ChoiceError(`no valid observer choice for ${host}`)
}

async function pickCandidate(env: InstallEnv, host: InstallHost, options: ChoiceOptions, retry: boolean): Promise<Candidate> {
  const flag = options.flags.find((entry) => entry.host === host)
  if (!retry && flag !== undefined) return { input: settingsInputFor(host, flag.provider, flag.model), origin: 'flag' }
  if (!retry && options.yes) return { input: defaultInput(host), origin: 'default' }
  if (env.io.interactive && !options.yes) return promptCandidate(env, host)
  throw new ChoiceError(`cannot ask about the ${host} observer without a TTY; pass --yes or --observer ${host}=<provider>:<model>`)
}

type CredentialState = { kind: 'none' } | { kind: 'keychain' } | { kind: 'entered'; value: string } | { kind: 'dry-run' }

interface CredentialSession {
  entered: Map<string, string>
  stdinUsed: boolean
}

async function readCredentialValue(env: InstallEnv, ref: string, options: ChoiceOptions, session: CredentialSession): Promise<string> {
  let value: string
  if (options.credentialStdin) {
    if (session.stdinUsed) throw new ChoiceError(`stdin was already read; cannot read another key for ${ref}`)
    session.stdinUsed = true
    value = await env.io.readStdin()
  } else if (env.io.interactive) {
    value = await env.io.askSecret(`Key for ${ref} (stored in the macOS Keychain, not shown) > `)
  } else {
    throw new ChoiceError(`the ${ref} key is not in the keychain and there is no TTY to ask; pass --credential-stdin`)
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
  const known = session.entered.get(ref)
  if (known !== undefined) return { kind: 'entered', value: known }
  const writer = credentialWriterFor(env.platform, env.security)
  if (writer === null) throw new ChoiceError(`${input.provider} needs a key, and storing keys needs the macOS Keychain; ${env.platform} is not supported yet`)
  if (writer.exists(ref) && !options.replaceCredential) return { kind: 'keychain' }
  if (options.dryRun) return { kind: 'dry-run' }
  const value = await readCredentialValue(env, ref, options, session)
  session.entered.set(ref, value)
  return { kind: 'entered', value }
}

function credentialNote(state: CredentialState, ref: string | null): string {
  if (state.kind === 'none' || ref === null) return 'no key needed'
  if (state.kind === 'keychain') return `keychain entry ${ref} present`
  if (state.kind === 'dry-run') return `keychain entry ${ref} missing or replaced: would ask for it (no echo) and store it`
  return `new key for ${ref} will be stored in the keychain`
}

function checkCredentials(env: InstallEnv, session: CredentialSession): CredentialProvider {
  const keychain = createKeychainProvider((args) => env.security({ args }))
  return { get: (ref) => session.entered.get(ref) ?? keychain.get(ref) }
}

/** ok, or the ObserverError class; never the reply or the payload. */
export async function runCheck(env: InstallEnv, input: ObserverSettingsInput, credentials: CredentialProvider): Promise<{ ok: true } | { ok: false; errorClass: string }> {
  try {
    await env.runnerFor(asSettings(input), credentials).run(CHECK_PROMPT)
    return { ok: true }
  } catch (error: unknown) {
    return { ok: false, errorClass: toObserverError(error).errorClass }
  }
}

async function chooseOne(env: InstallEnv, host: InstallHost, options: ChoiceOptions, session: CredentialSession): Promise<ObserverChoice> {
  for (let attempt = 0; attempt < MAX_CHOICE_ATTEMPTS; attempt += 1) {
    const candidate = await pickCandidate(env, host, options, attempt > 0)
    const ref = credentialRefFor(asSettings(candidate.input))
    const state = await resolveCredential(env, candidate.input, options, session)
    const base = { ...candidate, credential: state.kind === 'entered' && ref !== null ? { ref, value: state.value } : null, credentialNote: credentialNote(state, ref) }
    if (options.dryRun) return { ...base, check: 'not run (dry run)' }
    if (options.skipCheck) return { ...base, check: 'skipped' }
    const result = await runCheck(env, candidate.input, checkCredentials(env, session))
    if (result.ok) return { ...base, check: 'ok' }
    env.out(`observer check for ${host} (${describeInput(candidate.input)}) failed: ${result.errorClass}`)
    if (ref !== null) session.entered.delete(ref)
    if (options.yes || !env.io.interactive) throw new ChoiceError(`observer check for ${host} failed: ${result.errorClass}`)
  }
  throw new ChoiceError(`no working observer for ${host} after ${MAX_CHOICE_ATTEMPTS} tries`)
}

export async function chooseObservers(env: InstallEnv, hosts: readonly InstallHost[], options: ChoiceOptions): Promise<ObserverChoice[]> {
  const session: CredentialSession = { entered: new Map(), stdinUsed: false }
  const choices: ObserverChoice[] = []
  for (const host of hosts) choices.push(await chooseOne(env, host, options, session))
  return choices
}
