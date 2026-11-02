// Picks the runner the settings name, and nothing else (plan "No silent
// fallback"): a missing credential or a lookup failure is an ObserverError the
// caller records, never a reason to try another provider.

import { type CredentialProvider, isSystemCredentialRef } from '../../secrets/credentials'
import { OPENROUTER_CREDENTIAL_REF } from '../settings'
import { ObserverError, type ObserverRunner, type ObserverSettings } from '../types'
import { type SpawnFn, createClaudeCliRunner } from './claude-cli'
import { type FetchFn, createOpenRouterRunner } from './openrouter'

export interface RunnerDeps {
  dataDir: string
  credentials: CredentialProvider
  spawn?: SpawnFn
  fetch?: FetchFn
  parentEnv?: Readonly<Record<string, string | undefined>>
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
  if (settings.provider !== 'openrouter') {
    throw new ObserverError('config_invalid', `${settings.provider} observer is not built yet`)
  }
  const apiKey = readCredential(deps.credentials, settings.credentialRef ?? OPENROUTER_CREDENTIAL_REF)
  return createOpenRouterRunner({ apiKey, model: settings.model, ...(deps.fetch !== undefined ? { fetch: deps.fetch } : {}) })
}

export function runnerFactory(deps: RunnerDeps): RunnerFactory {
  return (settings) => createRunner(settings, deps)
}
