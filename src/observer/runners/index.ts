// Picks the runner the settings name, and nothing else (no silent
// fallback): a missing credential or a lookup failure is an ObserverError the
// caller records, never a reason to try another provider.

import { type CredentialProvider, isSystemCredentialRef } from '../../secrets/credentials'
import { CLAUDE_TOKEN_REF, credentialRefFor } from '../settings'
import { type CliLoginProvider, HTTP_API_PROVIDERS, type HttpApiProvider, ObserverError, type ObserverProvider, type ObserverRunner, type ObserverSettings, isCliLoginProvider } from '../types'
import { type SpawnFn, createClaudeCliRunner } from './claude-cli'
import { type CliAdapter, type CliObserverRunner, createCliObserverRunner } from './cli-core'
import { codexAdapter } from './codex-cli'
import { gooseAdapter } from './goose-cli'
import { opencodeAdapter } from './opencode-cli'
import { createApiRunner } from './api'
import type { FetchFn } from './http-core'

export interface RunnerDeps {
  dataDir: string
  credentials: CredentialProvider
  spawn?: SpawnFn
  fetch?: FetchFn
  parentEnv?: Readonly<Record<string, string | undefined>>
  /** Receives fixed, class-only lines from CLI login runners, such as a cleanup failure. */
  log?: (line: string) => void
  /** Tests: finds a CLI binary on the child's PATH. */
  which?: (command: string, path: string) => string | null
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

/** An entry that may be absent (null); a lookup that fails is an error, never read as absent. */
function optionalCredential(credentials: CredentialProvider, ref: string): string | null {
  try {
    return credentials.get(ref)
  } catch {
    throw new ObserverError('credential_error', `keychain lookup for ${ref} failed`)
  }
}

/** One adapter per CLI login provider. */
const CLI_ADAPTERS: Record<CliLoginProvider, CliAdapter> = { 'codex-cli': codexAdapter, 'opencode-cli': opencodeAdapter, 'goose-cli': gooseAdapter }

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
      oauthToken: () => optionalCredential(deps.credentials, CLAUDE_TOKEN_REF),
      ...(deps.spawn !== undefined ? { spawn: deps.spawn } : {}),
      ...(deps.parentEnv !== undefined ? { parentEnv: deps.parentEnv } : {}),
      ...(deps.which !== undefined ? { which: deps.which } : {}),
    })
  }
  if (isCliLoginProvider(settings.provider)) return createCliRunner(settings, deps)
  if (!isHttpApiProvider(settings.provider)) throw new ObserverError('config_invalid', `${settings.provider} has no runner`)
  const ref = credentialRefFor(settings)
  return createApiRunner(settings.provider, {
    apiKey: ref === null ? null : readCredential(deps.credentials, ref),
    model: settings.model,
    ...(settings.endpoint !== undefined ? { endpoint: settings.endpoint } : {}),
    ...(deps.fetch !== undefined ? { fetch: deps.fetch } : {}),
  })
}

function isHttpApiProvider(provider: ObserverProvider): provider is HttpApiProvider {
  return (HTTP_API_PROVIDERS as readonly string[]).includes(provider)
}

export function runnerFactory(deps: RunnerDeps): RunnerFactory {
  return (settings) => createRunner(settings, deps)
}
