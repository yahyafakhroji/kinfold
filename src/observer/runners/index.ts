// Picks the runner the settings name, and nothing else (plan "No silent
// fallback"): a missing credential or a lookup failure is an ObserverError the
// caller records, never a reason to try another provider.

import { type CredentialProvider, isSystemCredentialRef } from '../../secrets/credentials'
import { OPENROUTER_CREDENTIAL_REF } from '../settings'
import { CLI_LOGIN_PROVIDERS, type CliLoginProvider, ObserverError, type ObserverProvider, type ObserverRunner, type ObserverSettings } from '../types'
import { type SpawnFn, createClaudeCliRunner } from './claude-cli'
import { type CliAdapter, type CliObserverRunner, createCliObserverRunner } from './cli-core'
import { codexAdapter } from './codex-cli'
import { opencodeAdapter } from './opencode-cli'
import { type FetchFn, createOpenRouterRunner } from './openrouter'

export interface RunnerDeps {
  dataDir: string
  credentials: CredentialProvider
  spawn?: SpawnFn
  fetch?: FetchFn
  parentEnv?: Readonly<Record<string, string | undefined>>
  /** Receives fixed, class-only lines from CLI login runners, such as a cleanup failure. */
  log?: (line: string) => void
}

export type RunnerFactory = (settings: ObserverSettings) => ObserverRunner

function readCredential(credentials: CredentialProvider, ref: string): string {
  if (isSystemCredentialRef(ref)) throw new ObserverError('credential_error', `${ref} is a key Kinfold keeps for itself, not an observer credential`)
  let value: string | null
  try {
    value = credentials.get(ref)
  } catch {
    throw new ObserverError('credential_error', `keychain lookup for ${ref} failed`)
  }
  if (value === null) throw new ObserverError('credential_missing', `no keychain entry for ${ref}`)
  return value
}

/** One adapter per CLI login provider. */
const CLI_ADAPTERS: Record<CliLoginProvider, CliAdapter> = { 'codex-cli': codexAdapter, 'opencode-cli': opencodeAdapter }

function isCliLoginProvider(provider: ObserverProvider): provider is CliLoginProvider {
  return (CLI_LOGIN_PROVIDERS as readonly string[]).includes(provider)
}

/**
 * The one way to build a CLI login runner (run, probe, listModels). Throws
 * config_invalid for a provider that is not a CLI login observer.
 */
export function createCliRunner(settings: ObserverSettings, deps: RunnerDeps): CliObserverRunner {
  if (!isCliLoginProvider(settings.provider)) throw new ObserverError('config_invalid', `${settings.provider} is not a CLI login observer`)
  return createCliObserverRunner(CLI_ADAPTERS[settings.provider], {
    dataDir: deps.dataDir,
    model: settings.model,
    ...(deps.spawn !== undefined ? { spawn: deps.spawn } : {}),
    ...(deps.parentEnv !== undefined ? { parentEnv: deps.parentEnv } : {}),
    ...(deps.log !== undefined ? { log: deps.log } : {}),
  })
}

/** Throws ObserverError before any network or process work when the runner cannot be built. */
export function createRunner(settings: ObserverSettings, deps: RunnerDeps): ObserverRunner {
  if (settings.provider === 'claude-cli') {
    return createClaudeCliRunner({
      dataDir: deps.dataDir,
      model: settings.model,
      ...(deps.spawn !== undefined ? { spawn: deps.spawn } : {}),
      ...(deps.parentEnv !== undefined ? { parentEnv: deps.parentEnv } : {}),
    })
  }
  if (isCliLoginProvider(settings.provider)) return createCliRunner(settings, deps)
  const apiKey = readCredential(deps.credentials, settings.credentialRef ?? OPENROUTER_CREDENTIAL_REF)
  return createOpenRouterRunner({ apiKey, model: settings.model, ...(deps.fetch !== undefined ? { fetch: deps.fetch } : {}) })
}

export function runnerFactory(deps: RunnerDeps): RunnerFactory {
  return (settings) => createRunner(settings, deps)
}
