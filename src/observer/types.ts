// The observer contract: what goes to the model, what may come back, and the
// one runner interface every provider implements. A runner only turns a
// prompt into text; parsing, evidence and storage stay in the daemon, so a
// provider swap never changes what gets stored.

import type { EvidenceStrength } from '../evidence'

export const OBSERVATION_TYPES = ['discovery', 'decision', 'change', 'bugfix', 'feature', 'refactor', 'problem'] as const
export type ObservationType = (typeof OBSERVATION_TYPES)[number]

export const EVIDENCE_STRENGTHS: readonly EvidenceStrength[] = ['tool-verified', 'interpretation', 'user-stated']

/** One stored event as the observer sees it: the redacted payload, never the raw hook input. */
export interface ObserverEvent {
  eventId: string
  sessionId: number
  promptNumber: number | null
  kind: string
  toolName: string | null
  /** JSON of the event after edge and daemon redaction. */
  payload: string
  withheld: string | null
  occurredAt: number
}

export interface ObserverPrompt {
  system: string
  user: string
  /** The events rendered into `user`, in order. Only these may be cited. */
  eventIds: readonly string[]
}

/** How a new observation bears on one the session was shown as memory. */
export const RELATION_KINDS = ['confirms', 'updates', 'contradicts'] as const
export type RelationKind = (typeof RELATION_KINDS)[number]

export interface ObservationRelation {
  kind: RelationKind
  /** An id from the prior-memory block of the same run, in the same project. */
  observationId: number
}

export interface ParsedObservation {
  type: ObservationType
  title: string
  narrative: string
  facts: string[]
  files: string[]
  evidence: { strength: EvidenceStrength; sourceEventIds: string[] }
  relations: ObservationRelation[]
}

export interface ParsedSummary {
  request: string
  learned: string
  completed: string
  nextSteps: string
}

export interface ObserverOutput {
  observations: ParsedObservation[]
  summary: ParsedSummary | null
  /** Cited ids that were not in the batch, and observations dropped for having no valid citation left. */
  droppedIds: number
  droppedObservations: number
  /** Relations naming an id the run never showed (or another project's), an unknown kind, or a malformed entry. */
  droppedRelations: number
}

export interface RunnerUsage {
  inputTokens?: number
  outputTokens?: number
}

export interface RunnerResult {
  text: string
  /** The model that actually answered, when the provider reports it; else the configured one. */
  model: string
  usage?: RunnerUsage
}

export interface ObserverRunner {
  run(prompt: ObserverPrompt): Promise<RunnerResult>
}

export const OBSERVER_PROVIDERS = ['claude-cli', 'openrouter', 'codex-cli', 'opencode-cli'] as const
export type ObserverProvider = (typeof OBSERVER_PROVIDERS)[number]

/** Providers that borrow the user's own CLI login instead of a Keychain key. */
export const CLI_LOGIN_PROVIDERS = ['codex-cli', 'opencode-cli'] as const
export type CliLoginProvider = (typeof CLI_LOGIN_PROVIDERS)[number]

export interface ObserverSettings {
  provider: ObserverProvider
  model: string
  /** Keychain account name for the provider's key; null when the provider needs none. */
  credentialRef: string | null
  enabled: boolean
  /** Where the setting came from: a host row, the '*' row, or the built-in default. */
  source: 'host' | 'default-row' | 'built-in'
}

/** Error classes are the only failure detail that reaches logs and observer_runs. */
export const OBSERVER_ERROR_CLASSES = [
  'credential_missing',
  'credential_error',
  'cli_missing',
  'exit_nonzero',
  'timeout',
  'http_error',
  'bad_response',
  'bad_output',
  'config_invalid',
  'interrupted',
  'internal',
  'tool_attempt',
  'safety_check_failed',
] as const
export type ObserverErrorClass = (typeof OBSERVER_ERROR_CLASSES)[number]

/**
 * A failure we can name. `detail` is written by this codebase (an exit code, an
 * HTTP status, a validator message) and never carries prompt text or model output.
 */
export class ObserverError extends Error {
  readonly errorClass: ObserverErrorClass
  readonly detail: string

  constructor(errorClass: ObserverErrorClass, detail: string) {
    super(`${errorClass}: ${detail}`)
    this.name = 'ObserverError'
    this.errorClass = errorClass
    this.detail = detail
  }
}

export function toObserverError(error: unknown): ObserverError {
  if (error instanceof ObserverError) return error
  // Unknown errors keep only their name: a message could quote a payload.
  return new ObserverError('internal', error instanceof Error ? error.name : 'unknown error')
}
