// `kinfold status`: read-only. Hosts found and wired (yes/no/stale/partial), the
// LaunchAgent, daemon health, each host's observer and where it came from,
// the key store and its entries (metadata lookups only, never the value), the HMAC keys (master and legacy entries, sub-key epochs, leftover plain-text keys), data dir modes, and
// the time of the last backup, and duplicate project wiring. It creates nothing,
// not even the data dir.

import { readBackupRecord } from '../backup/record'
import type { EffectiveSettings } from '../daemon/settings-route'
import { OPENROUTER_CREDENTIAL_REF, providerTakesKey } from '../observer/settings'
import { getObserverSettings } from './daemon-client'
import { dbStatusLines } from './db-encryption'
import { detectHosts } from './detect'
import { isFoldedAbsent } from './detectors'
import { duplicateWarning, findDuplicateWiring } from './duplicates'
import { type InstallEnv, errorMessage, installPaths, platformOf } from './env'
import { keyStoreStatusLine, noStoreWord, readKeyStore } from './key-store-choice'
import { EXIT_OK, daemonSituation } from './install'
import { serviceOf } from './service/control'
import { hmacStatusLines } from './hmac-migration'
import { mcpStatusLines } from './mcp-wiring'
import { dataDirAccessFor } from './access/check'
import { vectorStatusLine } from './vec0-install'
import { updatesEnabled } from '../update/enabled'
import { availableMessage, pendingNotice } from '../update/notice'
import { readUpdateState } from '../update/state'
import { VERSION } from '../version'
import { readInstallRecord } from './setup/record'
import { type WslStatus, wslStatus } from '../wsl/entry'
import type { HookHostSpec } from '../agents/hook-spec'
import { HOOK_SPECS } from '../agents/hook-specs'
import { INSTALL_PROFILES, hasWiring, isWired, overlapPlan, overlapState } from '../agents/install-profiles'
import { type AgentId, type ProfileTable, capabilityLine, verificationNote } from '../agents/profile'

type SpecTable = Readonly<Record<AgentId, HookHostSpec | null>>

/** The agents wired now, as install would have chosen them. */
function wiredHosts(env: InstallEnv, profiles: ProfileTable): AgentId[] {
  return Object.values(profiles).flatMap((profile) => (isWired(profile.wiring.state(env)) ? [profile.id] : []))
}

async function hostLines(env: InstallEnv, profiles: ProfileTable, specs: SpecTable): Promise<string[]> {
  const os = platformOf(env).os
  const detections = await detectHosts(env, null, profiles)
  const overlap = overlapPlan(wiredHosts(env, profiles), env, profiles, specs)
  const folded: string[] = []
  const lines = detections.flatMap((detection) => {
    const profile = profiles[detection.host]
    const state = overlapState(env, profile, profiles)
    if (isFoldedAbsent(detection, hasWiring(state))) {
      folded.push(detection.host)
      return []
    }
    const found = detection.selected ? `detected${detection.version !== null ? ` ${detection.version}` : ''}` : `not detected (${detection.note})`
    const wired = profile.wiring.line(env)
    const note = verificationNote(profile.verification)
    const line = `  ${detection.host}: ${found}; wired: ${wired}; ${capabilityLine(profile, os)}${note === null ? '' : `; ${note}`}`
    // Steps and notes for an agent that is neither here nor wired would be noise on every status run.
    const present = detection.selected || isWired(state)
    const overlapNote = overlap.notes[profile.id]
    const extra = [...(overlapNote !== undefined ? [overlapNote] : []), ...profile.manualSteps(os, env)]
    return [line, ...(present ? extra.map((step) => `    ${step}`) : [])]
  })
  return folded.length > 0 ? [...lines, `  not found: ${folded.join(', ')}`] : lines
}

/** Every host's detection, wiring and capability line, then the MCP lines: what status prints under `hosts:`. */
export async function hostStatusLines(env: InstallEnv, profiles: ProfileTable = INSTALL_PROFILES, specs: SpecTable = HOOK_SPECS): Promise<string[]> {
  return [...(await hostLines(env, profiles, specs)), ...mcpStatusLines(env)]
}

async function daemonLines(env: InstallEnv): Promise<string[]> {
  const situation = await daemonSituation(env)
  const service = serviceOf(env)
  const label = service?.label ?? 'none'
  const config = service !== null && service.isConfigured() ? 'present' : 'missing'
  const owner = situation.health.up ? (situation.foreign ? `, not started by the ${label}` : situation.loaded || situation.legacyLoaded ? `, ${label}` : ', started by hand') : ''
  const pid = situation.pid !== null ? ` pid ${situation.pid}` : ''
  const health = situation.health.up
    ? `up on 127.0.0.1:${situation.port} version ${situation.health.version} schema ${situation.health.schemaVersion}${pid}${owner}`
    : `down (${situation.health.reason})`
  return [`service (${label}): config ${config}; running: ${situation.loaded ? 'yes' : 'no'}`, `daemon /health: ${health}`, vectorStatusLine(env, situation.health)]
}

function effectiveLine(entry: EffectiveSettings): string {
  if ('error' in entry) return `  ${entry.host}: invalid setting (${entry.error})`
  const { provider, model, credentialRef, enabled, source } = entry.settings
  return `  ${entry.host}: ${provider}/${model}${credentialRef !== null && providerTakesKey(provider) ? ` key ${credentialRef}` : ''}${enabled ? '' : ' (disabled)'}; source ${source}`
}

async function observerLines(env: InstallEnv): Promise<{ lines: string[]; refs: string[] }> {
  const read = await getObserverSettings(env)
  if (!read.ok) return { lines: [`observer settings: unknown (${read.reason})`], refs: [OPENROUTER_CREDENTIAL_REF] }
  const refs = read.view.effective.flatMap((entry) => ('settings' in entry && providerTakesKey(entry.settings.provider) ? [entry.settings.credentialRef ?? OPENROUTER_CREDENTIAL_REF] : []))
  return { lines: ['observer settings:', ...read.view.effective.map(effectiveLine)], refs: [...new Set([OPENROUTER_CREDENTIAL_REF, ...refs])] }
}

function keyStoreLines(env: InstallEnv, refs: readonly string[]): string[] {
  const read = readKeyStore(env)
  // The key store line above already names why the store is unknown.
  if (!read.ok) return []
  const store = read.store
  if (store === null) return [`${noStoreWord(env)}: none on ${env.platform}`]
  return refs.map((ref) => {
    try {
      return `${store.label} ${ref}: ${store.exists(ref) ? 'present' : 'missing'}`
    } catch (error: unknown) {
      return `${store.label} ${ref}: unknown (${errorMessage(error)})`
    }
  })
}

/** The database lines with the key store line right after the `database:` one. */
async function databaseLines(env: InstallEnv): Promise<string[]> {
  const [database, ...rest] = await dbStatusLines(env)
  return database === undefined ? [keyStoreStatusLine(env)] : [database, keyStoreStatusLine(env), ...rest]
}

/** The saved update state only: status never fetches. */
export function updateLine(env: InstallEnv, running: string = VERSION): string {
  const record = readInstallRecord(env.dataDir)
  const vars = env.envVars ?? {}
  if (!updatesEnabled(running, record, vars)) return 'update check: off'
  const state = readUpdateState(env.dataDir)
  const notice = pendingNotice(state, record, running, vars)
  if (notice !== null) return `update: ${availableMessage(notice)}`
  return `update: none known (${state.checkedAt === null ? 'never checked' : `last checked ${new Date(state.checkedAt).toISOString()}`})`
}

/** When the last backup was made, from backup.json; null when none was. Stated only: an old backup is the person's call. */
export function backupLine(env: InstallEnv): string | null {
  const record = readBackupRecord(env.dataDir)
  return record === null ? null : `backup: last made ${new Date(record.lastBackupAt).toISOString()}`
}

export async function status(env: InstallEnv, running: string = VERSION, profiles: ProfileTable = INSTALL_PROFILES): Promise<number> {
  let wsl: WslStatus | null = null
  if (platformOf(env).wsl) {
    // The Windows side can fail in ways this host cannot fix; the rest of status still holds.
    try {
      wsl = await wslStatus(env)
    } catch (error: unknown) {
      env.out(`WSL (preview): status unknown (${errorMessage(error)})`)
    }
  }
  for (const line of wsl?.lines ?? []) env.out(line)
  if (wsl?.replaces === true) return EXIT_OK
  const observer = await observerLines(env)
  const duplicates = findDuplicateWiring(env.cwd, [installPaths(env).claudeSettings])
  const lines = [
    'hosts:',
    ...(await hostStatusLines(env, profiles)),
    ...(await daemonLines(env)),
    ...(await databaseLines(env)),
    ...observer.lines,
    ...keyStoreLines(env, observer.refs),
    ...hmacStatusLines(env),
    ...(await dataDirAccessFor(env).statusLines(env.dataDir)),
    ...[backupLine(env)].filter((line) => line !== null),
    updateLine(env, running),
    ...(duplicates.length === 0 ? ['duplicate wiring: none in this directory'] : duplicateWarning(duplicates)),
  ]
  for (const line of lines) env.out(line)
  return EXIT_OK
}
