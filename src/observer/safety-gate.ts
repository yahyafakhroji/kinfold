// The daemon's safety gate for CLI login observers (codex-cli, opencode-cli).
// Before a batch goes to one of them, the gate probes the CLI and looks up
// (provider, version, binary path) in observer_safety. No row: it runs the
// planted-instruction test once and records the result. A failed row stops
// the observer: the batch is blocked, with no test and no model call, until
// the version or binary changes or the row is cleared. A probe failure is
// not remembered in the database, so a missing CLI is never stored as a
// safety failure; the gate keeps the last probe failure per provider in memory
// (probeFailures) so GET /observer/settings can show why nothing runs.
// Log lines carry provider, version, status and error class only: never the
// binary path, prompt text, model output or env values.

import type { Database } from '../sqlite/types'
import { type SafetyKey, getSafety, recordSafety } from '../store/observer-safety-store'
import { resetSafetyFailedEvents } from '../store/observer-reset'
import { runPlantedCheck } from './planted-check'
import type { CliObserverRunner } from './runners/cli-core'
import { CLI_LOGIN_PROVIDERS, type CliLoginProvider, type ObserverErrorClass, type ObserverProvider, type ObserverSettings, toObserverError } from './types'

export type GateResult = { ok: true } | { ok: false; errorClass: 'safety_check_failed' | 'tool_attempt' | ObserverErrorClass }

/** A provider whose last CLI probe failed, as the dashboard sees it: no path, no detail. */
export interface ProbeFailure {
  provider: CliLoginProvider
  errorClass: ObserverErrorClass
}

export interface SafetyGate {
  check(settings: ObserverSettings): Promise<GateResult>
  reportToolAttempt(settings: ObserverSettings): Promise<void>
  /** The last probe failure per provider; an entry goes once a probe of that provider succeeds. */
  probeFailures(): ProbeFailure[]
}

export interface SafetyGateDeps {
  db: Database
  cliRunnerFor: (settings: ObserverSettings) => CliObserverRunner
  plantedCheck?: typeof runPlantedCheck
  now?: () => number
  log?: (line: string) => void
}

const OK: GateResult = { ok: true }

type Probed = { ok: true; key: SafetyKey; runner: CliObserverRunner } | { ok: false; errorClass: ObserverErrorClass }

function isCliLoginProvider(provider: ObserverProvider): provider is CliLoginProvider {
  return (CLI_LOGIN_PROVIDERS as readonly string[]).includes(provider)
}

function keyString(key: SafetyKey): string {
  return JSON.stringify([key.provider, key.cliVersion, key.binaryPath])
}

export function createSafetyGate(deps: SafetyGateDeps): SafetyGate {
  const plantedCheck = deps.plantedCheck ?? runPlantedCheck
  const now = deps.now ?? Date.now
  const log = deps.log ?? (() => {})
  /** Single flight: one planted check per key at a time; the entry is removed once it settles. */
  const inFlight = new Map<string, Promise<GateResult>>()
  /** The last probe failure class per provider, so a missing CLI is logged once and not every tick. */
  const probeFailures = new Map<CliLoginProvider, ObserverErrorClass>()

  const line = (key: SafetyKey, rest: string): void => log(`observer safety provider=${key.provider} version=${key.cliVersion} ${rest}`)

  const probe = async (settings: ObserverSettings, provider: CliLoginProvider): Promise<Probed> => {
    try {
      const runner = deps.cliRunnerFor(settings)
      const found = await runner.probe()
      probeFailures.delete(provider)
      return { ok: true, runner, key: { provider, cliVersion: found.version, binaryPath: found.binaryPath } }
    } catch (error: unknown) {
      const errorClass = toObserverError(error).errorClass
      if (probeFailures.get(provider) !== errorClass) log(`observer safety provider=${provider} status=probe_failed error=${errorClass}`)
      probeFailures.set(provider, errorClass)
      return { ok: false, errorClass }
    }
  }

  const runCheck = async (key: SafetyKey, runner: CliObserverRunner): Promise<GateResult> => {
    try {
      const result = await plantedCheck(runner)
      if (!result.ok) {
        recordSafety(deps.db, key, 'failed', result.errorClass, now())
        line(key, `status=failed error=${result.errorClass}`)
        return { ok: false, errorClass: result.errorClass }
      }
      recordSafety(deps.db, key, 'passed', null, now())
      const reset = resetSafetyFailedEvents(deps.db, key.provider)
      line(key, `status=passed reset=${reset}`)
      return OK
    } catch (error: unknown) {
      // A store error: nothing is known about the CLI, so nothing is recorded.
      const errorClass = toObserverError(error).errorClass
      line(key, `status=check_error error=${errorClass}`)
      return { ok: false, errorClass }
    }
  }

  const check = async (settings: ObserverSettings): Promise<GateResult> => {
    if (!isCliLoginProvider(settings.provider)) return OK
    const probed = await probe(settings, settings.provider)
    if (!probed.ok) return { ok: false, errorClass: probed.errorClass }
    const row = getSafety(deps.db, probed.key)
    if (row?.status === 'passed') return OK
    if (row?.status === 'failed') return { ok: false, errorClass: (row.errorClass ?? 'safety_check_failed') as ObserverErrorClass }
    const id = keyString(probed.key)
    const running = inFlight.get(id)
    if (running !== undefined) return running
    const started = runCheck(probed.key, probed.runner)
    inFlight.set(id, started)
    const cleanup = (): void => {
      if (inFlight.get(id) === started) inFlight.delete(id)
    }
    started.then(cleanup, cleanup)
    return started
  }

  const reportToolAttempt = async (settings: ObserverSettings): Promise<void> => {
    if (!isCliLoginProvider(settings.provider)) return
    const probed = await probe(settings, settings.provider)
    if (!probed.ok) return
    try {
      recordSafety(deps.db, probed.key, 'failed', 'tool_attempt', now())
      line(probed.key, 'status=failed error=tool_attempt source=run')
    } catch (error: unknown) {
      line(probed.key, `status=record_error error=${toObserverError(error).errorClass}`)
    }
  }

  const listProbeFailures = (): ProbeFailure[] => [...probeFailures].map(([provider, errorClass]) => ({ provider, errorClass }))

  return { check, reportToolAttempt, probeFailures: listProbeFailures }
}
